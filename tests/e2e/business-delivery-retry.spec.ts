import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { AgentRuntime } from '../../src/business/agent-runtime.js';
import { BusinessMessageService } from '../../src/business/message-service.js';
import { ToolRegistry } from '../../src/business/tool-registry.js';
import type { BusinessDecisionModel } from '../../src/domain/ports.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';
import { MemoryBusinessRunStore } from '../../src/infra/business-runs.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryConversationStore } from '../../src/infra/conversations.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

class QuoteModel implements BusinessDecisionModel {
  async plan() {
    return {
      role: 'QUOTE' as const,
      reply: 'Orçamento criado.',
      toolCalls: [{ name: 'criar_orcamento_teste', input: { value: 1 } }],
      handoff: false,
      handoffReason: null,
    };
  }
}

class FailFirstSendProvider extends MockWhatsAppProvider {
  attempts = 0;

  override async sendText(input: { tenantId: string; to: string; text: string }) {
    this.attempts++;
    if (this.attempts === 1) throw new Error('temporary_send_failure');
    return super.sendText(input);
  }
}

describe('Business AI delivery retry', () => {
  it('retries only delivery after a send failure and never repeats tool side effects', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new FailFirstSendProvider();
    const collectors = new MemoryCollectorResolver([{
      collectorId: 'business-retry',
      tenantId: 'tenant-a',
      provider: 'mock',
      account: 'wa-1',
      purpose: 'BUSINESS',
      status: 'HEALTHY',
    }]);

    let toolExecutions = 0;
    const tools = new ToolRegistry(new MemoryAuditSink());
    tools.register({
      name: 'criar_orcamento_teste',
      description: 'Side effect used by the retry regression test',
      risk: 'WRITE',
      input: z.object({ value: z.number() }),
      execute: async () => {
        toolExecutions++;
        return { quoteId: 'q-1' };
      },
    });

    const runs = new MemoryBusinessRunStore();
    const business = new BusinessMessageService(
      new AgentRuntime(tools, new QuoteModel()),
      new MemoryConversationStore(),
      runs,
    );
    const service = new IngestionService(
      collectors,
      new Map([[provider.id, provider]]),
      new MemoryQuarantineStore(),
      repo,
      new FreightPipeline(repo, new CanonicalEntityResolver()),
      undefined,
      business,
    );

    const payload = {
      messageId: 'business-retry-1',
      text: 'Faça um orçamento.',
      routingAddress: '5511999999999',
    };

    await expect(service.ingest('mock', 'business-retry', payload))
      .rejects.toThrow('temporary_send_failure');

    expect(toolExecutions).toBe(1);
    expect(repo.raw.size).toBe(1);
    expect([...runs.rows.values()][0]?.state).toBe('PENDING_SEND');

    const replay = await service.ingest('mock', 'business-retry', payload);

    expect(replay[0]?.disposition).toBe('DUPLICATE');
    expect(replay[0]?.replyMessageId).toMatch(/^mock-/);
    expect(toolExecutions).toBe(1);
    expect(provider.attempts).toBe(2);
    expect(provider.sent).toEqual([{
      to: '5511999999999',
      text: 'Orçamento criado.',
    }]);
    expect([...runs.rows.values()][0]?.state).toBe('SENT');

    const secondReplay = await service.ingest('mock', 'business-retry', payload);
    expect(secondReplay[0]?.disposition).toBe('DUPLICATE');
    expect(toolExecutions).toBe(1);
    expect(provider.attempts).toBe(2);
  });
});
