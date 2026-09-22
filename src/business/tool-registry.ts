import { z } from 'zod';
import type { AuditSink } from '../domain/ports.js';
import { authorizeTool, type ToolRisk } from '../security/policy.js';

export type ToolContext = {
  tenantId: string;
  actor: string;
  role: 'system' | 'agent' | 'human';
  approved?: boolean;
  conversationId?: string;
  sourceMessageId?: string;
};

type RegisteredTool<I, O> = {
  name: string;
  description: string;
  risk: ToolRisk;
  input: z.ZodType<I>;
  execute: (input: I, context: ToolContext) => Promise<O>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool<unknown, unknown>>();

  constructor(private readonly audit: AuditSink) {}

  register<I, O>(tool: RegisteredTool<I, O>): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate_tool:${tool.name}`);
    this.tools.set(tool.name, tool as RegisteredTool<unknown, unknown>);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list() {
    return [...this.tools.values()].map(({ name, description, risk }) => ({
      name,
      description,
      risk,
    }));
  }

  prepare(name: string, rawInput: unknown) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown_tool:${name}`);
    return {
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      input: tool.input.parse(rawInput),
    };
  }

  async call(name: string, rawInput: unknown, context: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown_tool:${name}`);
    const prepared = this.prepare(name, rawInput);

    const authorization = authorizeTool({
      risk: prepared.risk,
      role: context.role,
      tenantMatch: true,
      explicitlyApproved: context.approved,
    });
    if (!authorization.allowed) {
      await this.audit.write({
        tenantId: context.tenantId,
        actor: context.actor,
        action: name,
        outcome: 'DENY',
        metadata: { reason: authorization.reason },
      });
      throw new Error(`tool_denied:${authorization.reason}`);
    }

    try {
      const output = await tool.execute(prepared.input, context);
      await this.audit.write({
        tenantId: context.tenantId,
        actor: context.actor,
        action: name,
        outcome: 'ALLOW',
      });
      return output;
    } catch (error) {
      await this.audit.write({
        tenantId: context.tenantId,
        actor: context.actor,
        action: name,
        outcome: 'ERROR',
        metadata: { error: error instanceof Error ? error.message : 'unknown' },
      });
      throw error;
    }
  }
}

export const BusinessToolSchemas = {
  buscar_produto: z.object({ query: z.string().min(1).max(200) }),
  consultar_preco: z.object({ productId: z.string().min(1) }),
  consultar_estoque: z.object({ productId: z.string().min(1), locationId: z.string().optional() }),
  criar_cliente: z.object({
    name: z.string().min(1),
    phone: z.string().min(6),
    email: z.string().email().optional(),
  }),
  criar_lead: z.object({
    name: z.string().min(1),
    phone: z.string().min(6),
    interest: z.string().optional(),
  }),
  criar_orcamento: z.object({
    customerId: z.string(),
    items: z.array(z.object({ productId: z.string(), quantity: z.number().positive() })).min(1),
  }),
  criar_pedido: z.object({
    quoteId: z.string().optional(),
    customerId: z.string(),
    items: z.array(z.object({ productId: z.string(), quantity: z.number().positive() })).min(1),
  }),
  consultar_pedido: z.object({ orderId: z.string() }),
  agendar: z.object({
    customerId: z.string(),
    startsAt: z.string().datetime(),
    purpose: z.string().min(1),
  }),
  registrar_pagamento: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
    reference: z.string(),
  }),
  criar_followup: z.object({
    customerId: z.string().uuid(),
    at: z.string().datetime(),
    reason: z.string().min(1).max(500),
    message: z.string().min(1).max(4000),
  }),
  transferir_humano: z.object({
    reason: z.string().min(1),
  }),
};
