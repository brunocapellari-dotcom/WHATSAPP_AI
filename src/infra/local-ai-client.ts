import type { AiUsageObserver } from '../observability/ai-usage.js';

export type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
};

type OllamaChatResponse = {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
};

export class LocalAiClient {
  constructor(private readonly options: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
    observeUsage?: AiUsageObserver;
  }) {}

  get model() { return this.options.model; }

  async chat(input: {
    operation: string;
    system: string;
    user: string;
    schema?: Record<string, unknown>;
    images?: string[];
  }): Promise<string> {
    const startedAt = performance.now();
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: input.system },
            {
              role: 'user',
              content: input.user,
              ...(input.images?.length ? { images: input.images } : {}),
            },
          ] satisfies OllamaChatMessage[],
          ...(input.schema ? { format: input.schema } : {}),
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(`local_ai_failed:${response.status}`);
    }

    const body = await response.json() as OllamaChatResponse;
    const content = body.message?.content?.trim();
    if (!content) throw new Error('local_ai_empty_response');

    this.options.observeUsage?.({
      operation: input.operation,
      model: body.model ?? this.options.model,
      latencySeconds: (performance.now() - startedAt) / 1000,
      inputTokens: Math.max(0, body.prompt_eval_count ?? 0),
      cachedInputTokens: Math.max(0, body.prompt_eval_cached_count ?? 0),
      outputTokens: Math.max(0, body.eval_count ?? 0),
    });

    return content;
  }

  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    try {
      const response = await fetch(
        `${this.options.baseUrl.replace(/\/$/, '')}/api/tags`,
        { signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 5_000)) },
      );
      if (!response.ok) return { ok: false, details: { status: response.status } };
      const body = await response.json() as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).flatMap((x) => [x.name, x.model]).filter(Boolean);
      const exact = names.includes(this.options.model);
      const family = names.some((name) => String(name).split(':')[0] === this.options.model.split(':')[0]);
      return {
        ok: exact || family,
        details: {
          model: this.options.model,
          installed: exact,
          compatibleFamilyPresent: family,
        },
      };
    } catch (error) {
      return {
        ok: false,
        details: { error: error instanceof Error ? error.message : 'local_ai_unavailable' },
      };
    }
  }
}
