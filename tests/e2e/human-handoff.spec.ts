import { describe, expect, it } from 'vitest';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { AgentRuntime } from '../../src/business/agent-runtime.js';
import { BusinessMessageService } from '../../src/business/message-service.js';
import { BusinessToolSchemas, ToolRegistry } from '../../src/business/tool-registry.js';
import type { BusinessDecisionModel } from '../../src/domain/ports.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryConversationStore } from '../../src/infra/conversations.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

class HandoffModel implements BusinessDecisionModel {
  async plan() {
    return {
      role: 'HUMAN_HANDOFF' as const,
      reply: 'Vou transferir para uma pessoa.',
      toolCalls: [],
      handoff: true,
      handoffReason: 'customer_requested_human',
    };
  }
}

describe('Business AI human handoff', () => {
  it('binds the handoff to the system-created conversation id, not LLM input', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MockWhatsAppProvider();
    const collectors = new MemoryCollectorResolver([{
      collectorId: 'business-handoff',
      tenantId: 'tenant-a',
      provider: 'mock',
      account: 'wa-1',
      purpose: 'BUSINESS',
      status: 'HEALTHY',
    }]);
    const conversations = new MemoryConversationStore();
    const audit = new MemoryAuditSink();
    const tools = new ToolRegistry(audit);
    const transferred: Array<{ conversationId?: string; reason: string }> = [];

    tools.register({
      name: 'transferir_humano',
      description: 'Transfere a conversa atual',
      risk: 'WRITE',
      input: BusinessToolSchemas.transferir_humano,
      execute: async (input, context) => {
        transferred.push({ conversationId: context.conversationId, reason: input.reason });
        return { transferred: true };
      },
    });

    const business = new BusinessMessageService(
      new AgentRuntime(tools, new HandoffModel()),
      conversations,
    );
    const ingestion = new IngestionService(
      collectors,
      new Map([[provider.id, provider]]),
      new MemoryQuarantineStore(),
      repo,
      new FreightPipeline(repo, new CanonicalEntityResolver()),
      undefined,
      business,
    );

    const result = await ingestion.ingest('mock', 'business-handoff', {
      messageId: 'handoff-1',
      text: 'Quero falar com uma pessoa.',
      chatId: 'chat-ref',
      routingAddress: '5511999999999',
    });

    expect(result[0]?.handoff).toBe(true);
    expect(transferred).toHaveLength(1);
    expect(transferred[0]?.conversationId).toBeTruthy();
    expect(transferred[0]?.conversationId).toBe(
      [...conversations.rows.values()][0]?.conversationId,
    );
    expect(transferred[0]?.reason).toBe('customer_requested_human');
  });
});
