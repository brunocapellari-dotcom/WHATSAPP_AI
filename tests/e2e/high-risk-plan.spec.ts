import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BusinessDecisionModel } from '../../src/domain/ports.js';
import { AgentRuntime } from '../../src/business/agent-runtime.js';
import type { ApprovalRequester } from '../../src/business/approval-service.js';
import { ToolRegistry } from '../../src/business/tool-registry.js';
import { MemoryAuditSink } from '../../src/infra/audit.js';

class MixedRiskModel implements BusinessDecisionModel {
  async plan() {
    return {
      role: 'SALES' as const,
      reply: 'Executando ações.',
      toolCalls: [
        { name: 'escrita_comum', input: { value: 'x' } },
        {
          name: 'acao_financeira',
          input: { amount: 100, reference: 'ref-1' },
        },
      ],
      handoff: false,
      handoffReason: null,
    };
  }
}

describe('high-risk plans', () => {
  it('executes no business tool before the financial approval decision', async () => {
    const tools = new ToolRegistry(new MemoryAuditSink());
    let ordinaryWrites = 0;
    let financialWrites = 0;
    let handoffs = 0;
    const approvalRequests: unknown[] = [];

    tools.register({
      name: 'escrita_comum',
      description: 'Common write',
      risk: 'WRITE',
      input: z.object({ value: z.string() }),
      execute: async () => {
        ordinaryWrites++;
        return { ok: true };
      },
    });
    tools.register({
      name: 'acao_financeira',
      description: 'Financial action',
      risk: 'FINANCIAL',
      input: z.object({
        amount: z.number().positive(),
        reference: z.string(),
      }),
      execute: async () => {
        financialWrites++;
        return { ok: true };
      },
    });
    tools.register({
      name: 'transferir_humano',
      description: 'Human handoff',
      risk: 'WRITE',
      input: z.object({ reason: z.string() }),
      execute: async () => {
        handoffs++;
        return { transferred: true };
      },
    });

    const approvals: ApprovalRequester = {
      async request(input) {
        approvalRequests.push(input);
        return {
          approvalId: '00000000-0000-4000-8000-000000000001',
          status: 'PENDING',
        };
      },
    };

    const runtime = new AgentRuntime(tools, new MixedRiskModel(), approvals);
    const result = await runtime.handleMessage('Registre o pagamento.', {
      tenantId: 'tenant-a',
      role: 'agent',
      conversationId: '00000000-0000-4000-8000-000000000002',
      sourceMessageId: 'message-1',
    });

    expect(result.handoff).toBe(true);
    expect(result.handoffReason).toBe('human_approval_required');
    expect(ordinaryWrites).toBe(0);
    expect(financialWrites).toBe(0);
    expect(handoffs).toBe(1);
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      tenantId: 'tenant-a',
      toolName: 'acao_financeira',
      risk: 'FINANCIAL',
      sourceMessageId: 'message-1',
    });
  });
});
