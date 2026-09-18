import type { BusinessDecisionModel } from '../domain/ports.js';
import { assessUntrustedText } from '../security/policy.js';
import type { ToolContext, ToolRegistry } from './tool-registry.js';

export type AgentRole =
  | 'FRONT_DESK'
  | 'SALES'
  | 'QUOTE'
  | 'CRM'
  | 'SCHEDULING'
  | 'SUPPORT'
  | 'HUMAN_HANDOFF';

type RuntimeToolResult = {
  name: string;
  ok: boolean;
  output?: unknown;
  error?: string;
};

export class AgentRuntime {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly model?: BusinessDecisionModel,
  ) {}

  async inspectInbound(text: string) {
    const security = assessUntrustedText(text);
    return {
      security,
      toolCatalog: this.tools.list(),
      llmConfigured: Boolean(this.model),
    };
  }

  async executeTool(
    role: AgentRole,
    tool: string,
    input: unknown,
    context: Omit<ToolContext, 'actor'>,
  ) {
    return this.tools.call(tool, input, {
      ...context,
      actor: `agent:${role}`,
    });
  }

  async forceHandoff(reason: string, context: Omit<ToolContext, 'actor'>) {
    const toolResults: RuntimeToolResult[] = [];
    await this.persistHandoff(reason, context, toolResults);
    return {
      persisted: toolResults.some(
        (result) => result.name === 'transferir_humano' && result.ok,
      ),
      toolResults,
    };
  }

  async handleMessage(text: string, context: Omit<ToolContext, 'actor'>) {
    const inspection = await this.inspectInbound(text);
    const toolResults: RuntimeToolResult[] = [];

    if (!this.model) {
      await this.persistHandoff('llm_unavailable', context, toolResults);
      return {
        role: 'HUMAN_HANDOFF' as const,
        reply: 'Atendimento automático indisponível; transferindo para atendimento humano.',
        handoff: true,
        handoffReason: 'llm_unavailable',
        toolResults,
        suspiciousInput: inspection.security.suspicious,
      };
    }

    const plan = await this.model.plan({
      message: inspection.security.content,
      tools: inspection.toolCatalog,
      suspicious: inspection.security.suspicious,
    });

    for (const call of plan.toolCalls) {
      try {
        const output = await this.executeTool(plan.role, call.name, call.input, context);
        toolResults.push({ name: call.name, ok: true, output });
      } catch (error) {
        toolResults.push({
          name: call.name,
          ok: false,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    const plannedToolFailed = toolResults.some((result) => !result.ok);
    const handoffReason = plannedToolFailed
      ? 'tool_failure'
      : plan.handoffReason ?? (plan.handoff ? 'agent_handoff' : null);
    const handoff = plan.handoff || plannedToolFailed;

    if (handoff) {
      await this.persistHandoff(handoffReason ?? 'agent_handoff', context, toolResults);
    }

    const persistenceFailed = toolResults.some(
      (result) => result.name === 'transferir_humano' && !result.ok,
    );
    const anyFailure = plannedToolFailed || persistenceFailed;

    return {
      role: handoff || anyFailure ? 'HUMAN_HANDOFF' as const : plan.role,
      reply: anyFailure
        ? 'Não consegui concluir uma ação com segurança; vou transferir para atendimento humano.'
        : plan.reply,
      handoff: handoff || anyFailure,
      handoffReason: anyFailure ? 'tool_failure' : handoffReason,
      toolResults,
      suspiciousInput: inspection.security.suspicious,
    };
  }

  private async persistHandoff(
    reason: string,
    context: Omit<ToolContext, 'actor'>,
    toolResults: RuntimeToolResult[],
  ) {
    if (!context.conversationId || !this.tools.has('transferir_humano')) return;
    if (toolResults.some((result) => result.name === 'transferir_humano' && result.ok)) return;

    try {
      const output = await this.executeTool(
        'HUMAN_HANDOFF',
        'transferir_humano',
        { reason },
        context,
      );
      toolResults.push({ name: 'transferir_humano', ok: true, output });
    } catch (error) {
      toolResults.push({
        name: 'transferir_humano',
        ok: false,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}
