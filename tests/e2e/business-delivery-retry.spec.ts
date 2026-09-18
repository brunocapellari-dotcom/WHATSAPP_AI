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
import { ProviderSendError } from '../../src/providers/errors.js';
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
    if (this.attempts === 1) {
      throw new ProviderSendError('temporary_send_failure', false);
    }
    return super.sendText(input);
  }
}

class UncertainSendProvider extends MockWhatsAppProvider {
  attempts = 0;

  override async sendText(_input: { tenantId: string; to: string; text: string }) {
    this.attempts++;
    throw new ProviderSendError('transport_timeout', true);
  }
}

function buildFixture(provider: MockWhatsAppProvider) {
  const repo = new MemoryMessageRepository();
  const collectors = new MemoryCollectorResolver([{
    collectorId: 'business-retry',
    tenantId: 'tenant-a',
    provider: 'mock',
    account: 'wa-1',
    purpose: 'BUSINESS',
    status: 'HEALTHY',
  }]);

  let toolExecutions = 0;
  let handoffs = 0;
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
  tools.register({
    name: 'transferir_humano',
    description: 'Persists human handoff in regression tests',
    risk: 'WRITE',
    input: z.object({ reason: z.string() }),
    execute: async () => {
      handoffs++;
      return { transferred: true };
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

  return {
    repo,
    runs,
    service,
    getToolExecutions: () => toolExecutions,
    getHandoffs: () => handoffs,
  };
}

const payload = {
  messageId: 'business-retry-1',
  text: 'Faça um orçamento.',
  routingAddress: '5511999999999',
};

describe('Business AI delivery retry', () => {
  it('retries only delivery after a definite pre-delivery failure and never repeats tool side effects', async () => {
    const provider = new FailFirstSendProvider();
    const fixture = buildFixture(provider);

    await expect(fixture.service.ingest('mock', 'business-retry', payload))
      .rejects.toThrow('temporary_send_failure');

    expect(fixture.getToolExecutions()).toBe(1);
    expect(fixture.repo.raw.size).toBe(1);
    expect([...fixture.runs.rows.values()][0]?.state).toBe('PENDING_SEND');

    const replay = await fixture.service.ingest('mock', 'business-retry', payload);

    expect(replay[0]?.disposition).toBe('DUPLICATE');
    expect(replay[0]?.replyMessageId).toMatch(/^mock-/);
    expect(fixture.getToolExecutions()).toBe(1);
    expect(provider.attempts).toBe(2);
    expect(provider.sent).toEqual([{
      to: '5511999999999',
      text: 'Orçamento criado.',
    }]);
    expect([...fixture.runs.rows.values()][0]?.state).toBe('SENT');

    const secondReplay = await fixture.service.ingest('mock', 'business-retry', payload);
    expect(secondReplay[0]?.disposition).toBe('DUPLICATE');
    expect(fixture.getToolExecutions()).toBe(1);
    expect(provider.attempts).toBe(2);
  });

  it('never auto-resends when transport failure makes delivery uncertain', async () => {
    const provider = new UncertainSendProvider();
    const fixture = buildFixture(provider);

    const first = await fixture.service.ingest('mock', 'business-retry', payload);

    expect(first[0]?.disposition).toBe('PROMOTED');
    expect(first[0]?.handoff).toBe(true);
    expect(first[0]?.replyMessageId).toBeUndefined();
    expect(fixture.getToolExecutions()).toBe(1);
    expect(fixture.getHandoffs()).toBe(1);
    expect(provider.attempts).toBe(1);
    expect([...fixture.runs.rows.values()][0]?.state).toBe('DELIVERY_UNCERTAIN');

    const replay = await fixture.service.ingest('mock', 'business-retry', payload);
    expect(replay[0]?.disposition).toBe('DUPLICATE');
    expect(replay[0]?.handoff).toBe(true);
    expect(provider.attempts).toBe(1);
    expect(fixture.getToolExecutions()).toBe(1);
  });
});
