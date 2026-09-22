import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { AgentRuntime } from '../../src/business/agent-runtime.js';
import { BusinessMessageService } from '../../src/business/message-service.js';
import { ToolRegistry } from '../../src/business/tool-registry.js';
import type { BusinessDecisionModel } from '../../src/domain/ports.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';
import { MemoryBusinessRunStore } from '../../src/infra/business-runs.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryConversationStore } from '../../src/infra/conversations.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

class HandoffModel implements BusinessDecisionModel {
  plans = 0;

  async plan() {
    this.plans++;
    return {
      role: 'SUPPORT' as const,
      reply: 'Vou transferir para uma pessoa.',
      toolCalls: [],
      handoff: true,
      handoffReason: 'customer_requested_human',
    };
  }
}

describe('human handoff suspends Business AI', () => {
  it('stores later inbound messages but executes no AI/tool/reply while human handoff is active', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MockWhatsAppProvider();
    const conversations = new MemoryConversationStore();
    const runs = new MemoryBusinessRunStore();
    const audit = new MemoryAuditSink();
    const tools = new ToolRegistry(audit);
    let handoffCalls = 0;

    tools.register({
      name: 'transferir_humano',
      description: 'Handoff',
      risk: 'WRITE',
      input: z.object({ reason: z.string() }),
      execute: async (_input, context) => {
        handoffCalls++;
        const row = [...conversations.rows.values()].find(
          (candidate) => candidate.conversationId === context.conversationId,
        );
        if (!row) throw new Error('conversation_not_found');
        row.state = 'WAITING_HUMAN';
        return { transferred: true };
      },
    });

    const model = new HandoffModel();
    const business = new BusinessMessageService(
      new AgentRuntime(tools, model),
      conversations,
      runs,
    );
    const collectors = new MemoryCollectorResolver([{
      collectorId: 'business-handoff',
      tenantId: 'tenant-a',
      provider: 'mock',
      account: 'wa-1',
      purpose: 'BUSINESS',
      status: 'HEALTHY',
    }]);
    const ingestion = new IngestionService(
      collectors,
      new Map([[provider.id, provider]]),
      new MemoryQuarantineStore(),
      repo,
      new FreightPipeline(repo, new CanonicalEntityResolver()),
      undefined,
      business,
    );

    const first = await ingestion.ingest('mock', 'business-handoff', {
      messageId: 'handoff-1',
      text: 'Quero falar com uma pessoa.',
      routingAddress: '5511999999999',
    });

    expect(first[0]?.handoff).toBe(true);
    expect(model.plans).toBe(1);
    expect(handoffCalls).toBe(1);
    expect(provider.sent).toHaveLength(1);

    const second = await ingestion.ingest('mock', 'business-handoff', {
      messageId: 'handoff-2',
      text: 'Ainda estou aguardando.',
      routingAddress: '5511999999999',
    });

    expect(second[0]?.disposition).toBe('PROMOTED');
    expect(second[0]?.handoff).toBe(true);
    expect(second[0]?.replyMessageId).toBeUndefined();
    expect(repo.raw.size).toBe(2);
    expect(model.plans).toBe(1);
    expect(handoffCalls).toBe(1);
    expect(provider.sent).toHaveLength(1);

    const row = [...conversations.rows.values()][0];
    expect(row?.state).toBe('WAITING_HUMAN');
  });
});
