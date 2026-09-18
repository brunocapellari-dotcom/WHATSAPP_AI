import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IngestionService } from '../../src/app/ingestion-service.js';
import { BusinessMessageService } from '../../src/business/message-service.js';
import { AgentRuntime } from '../../src/business/agent-runtime.js';
import { ToolRegistry } from '../../src/business/tool-registry.js';
import type { BusinessDecisionModel } from '../../src/domain/ports.js';
import { FreightPipeline } from '../../src/freight/pipeline.js';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';
import { MemoryCollectorResolver } from '../../src/infra/collectors.js';
import { MemoryConversationStore } from '../../src/infra/conversations.js';
import { MemoryBusinessRunStore } from '../../src/infra/business-runs.js';
import { MemoryMessageRepository } from '../../src/infra/memory-repository.js';
import { MemoryQuarantineStore } from '../../src/infra/quarantine.js';
import { MockWhatsAppProvider } from '../../src/providers/mock-provider.js';

class Model implements BusinessDecisionModel {
  async plan() {
    return { role: 'SALES' as const, reply: 'Preço consultado com segurança.', toolCalls: [{ name: 'consultar_preco', input: { productId: 'sku-1' } }], handoff: false, handoffReason: null };
  }
}

describe('Business AI provider-to-reply E2E', () => {
  it('normalizes, stores, plans, executes structured tool and replies through same provider', async () => {
    const repo = new MemoryMessageRepository();
    const provider = new MockWhatsAppProvider();
    const collectors = new MemoryCollectorResolver([{ collectorId: 'business-1', tenantId: 'tenant-a', provider: 'mock', account: 'wa-1', purpose: 'BUSINESS', status: 'HEALTHY' }]);
    const tools = new ToolRegistry(new MemoryAuditSink());
    tools.register({ name: 'consultar_preco', description: 'Preço real', risk: 'READ', input: z.object({ productId: z.string() }), execute: async () => ({ price: 99.9, currency: 'BRL' }) });
    const business = new BusinessMessageService(new AgentRuntime(tools, new Model()), new MemoryConversationStore(), new MemoryBusinessRunStore());
    const ingestion = new IngestionService(collectors, new Map([[provider.id, provider]]), new MemoryQuarantineStore(), repo, new FreightPipeline(repo, new CanonicalEntityResolver()), undefined, business);

    const result = await ingestion.ingest('mock', 'business-1', { messageId: 'b1', text: 'Qual o preço?', routingAddress: '5511999999999' });
    expect(result[0]?.disposition).toBe('PROMOTED');
    expect(result[0]?.replyMessageId).toMatch(/^mock-/);
    expect(provider.sent).toEqual([{ to: '5511999999999', text: 'Preço consultado com segurança.' }]);
    expect(repo.raw.size).toBe(1);
  });
});
