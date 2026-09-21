import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAiClient } from '../../src/infra/local-ai-client.js';
import { LocalBusinessModel } from '../../src/infra/local-business-model.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local zero-cost AI client', () => {
  it('sends structured-output schemas and local image bytes to Ollama', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const observeUsage = vi.fn();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: 'qwen3-vl:4b-instruct',
        message: { role: 'assistant', content: '{"text":"R$ 180"}' },
        prompt_eval_count: 20,
        prompt_eval_cached_count: 5,
        eval_count: 8,
        done: true,
      });
    });

    const client = new LocalAiClient({
      baseUrl: 'http://ollama:11434',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 30_000,
      observeUsage,
    });
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    };

    const result = await client.chat({
      operation: 'vision_test',
      system: 'Extract.',
      user: 'Read image.',
      images: ['AQID'],
      schema,
    });

    expect(result).toBe('{"text":"R$ 180"}');
    expect(requestUrl).toBe('http://ollama:11434/api/chat');
    expect(requestBody).toMatchObject({
      model: 'qwen3-vl:4b-instruct',
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0 },
    });
    const messages = requestBody?.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.images).toEqual(['AQID']);
    expect(observeUsage).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'vision_test',
      model: 'qwen3-vl:4b-instruct',
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 8,
    }));
  });

  it('fails closed on local AI HTTP errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'down' }, 503));
    const client = new LocalAiClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 30_000,
    });

    await expect(client.chat({
      operation: 'test',
      system: 'system',
      user: 'user',
    })).rejects.toThrow('local_ai_failed:503');
  });

  it('reports the configured local model as ready', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      models: [{ name: 'qwen3-vl:4b-instruct', model: 'qwen3-vl:4b-instruct' }],
    }));
    const client = new LocalAiClient({
      baseUrl: 'http://ollama:11434',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 30_000,
    });
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.details).toMatchObject({ installed: true });
  });
});

describe('local Business model', () => {
  it('rejects tool names that are not in the deterministic registry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      model: 'qwen3-vl:4b-instruct',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          role: 'SALES',
          reply: 'Vou executar.',
          toolCalls: [{ name: 'executar_shell', inputJson: '{}' }],
          handoff: false,
          handoffReason: null,
        }),
      },
    }));

    const model = new LocalBusinessModel(new LocalAiClient({
      baseUrl: 'http://ollama:11434',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 30_000,
    }));

    const plan = await model.plan({
      message: 'Faça isso.',
      tools: [{ name: 'consultar_preco', description: 'Consulta preço', risk: 'READ' }],
      suspicious: false,
    });

    expect(plan.role).toBe('HUMAN_HANDOFF');
    expect(plan.toolCalls).toEqual([]);
    expect(plan.handoff).toBe(true);
    expect(plan.handoffReason).toBe('invalid_tool_request');
  });

  it('creates the final reply from actual structured tool results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      model: 'qwen3-vl:4b-instruct',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          reply: 'O preço disponível é R$ 180,00.',
          handoff: false,
          handoffReason: null,
        }),
      },
    }));

    const model = new LocalBusinessModel(new LocalAiClient({
      baseUrl: 'http://ollama:11434',
      model: 'qwen3-vl:4b-instruct',
      timeoutMs: 30_000,
    }));

    const result = await model.finalize({
      message: 'Qual é o preço?',
      plan: {
        role: 'SALES',
        reply: 'Vou consultar.',
        toolCalls: [],
        handoff: false,
        handoffReason: null,
      },
      toolResults: [{
        name: 'consultar_preco',
        ok: true,
        output: { price: 180, currency: 'BRL' },
      }],
    });

    expect(result.reply).toContain('180');
    expect(result.handoff).toBe(false);
  });
});
