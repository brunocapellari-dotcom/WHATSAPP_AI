export type AiUsageSample = {
  operation: string;
  model: string;
  latencySeconds: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
};

export type AiUsageObserver = (sample: AiUsageSample) => void;

type ResponsesUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens?: number;
} | null | undefined;

type TokenPrice = {
  input: number;
  cachedInput: number;
  output: number;
};

// USD per 1M tokens. Snapshot verified against official OpenAI model pricing on 2026-09-16.
// Unknown/future models are still measured for tokens and latency but intentionally have no cost estimate.
export const MODEL_PRICING_USD_PER_MILLION: Readonly<Record<string, TokenPrice>> = Object.freeze({
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5.6': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-6-astra': { input: 10, cachedInput: 1, output: 50 },
});

export function estimateTextCostUsd(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | undefined {
  const price = MODEL_PRICING_USD_PER_MILLION[model];
  if (!price) return undefined;

  const safeInput = Math.max(0, inputTokens);
  const safeCached = Math.min(safeInput, Math.max(0, cachedInputTokens));
  const uncachedInput = safeInput - safeCached;
  const longContextMultiplier = safeInput > 272_000 ? 2 : 1;
  const outputMultiplier = safeInput > 272_000 ? 1.5 : 1;

  return (
    uncachedInput * price.input * longContextMultiplier
    + safeCached * price.cachedInput * longContextMultiplier
    + Math.max(0, outputTokens) * price.output * outputMultiplier
  ) / 1_000_000;
}

export function responseUsageSample(input: {
  operation: string;
  model: string;
  latencySeconds: number;
  usage: ResponsesUsage;
}): AiUsageSample {
  const inputTokens = Math.max(0, input.usage?.input_tokens ?? 0);
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, input.usage?.input_tokens_details?.cached_tokens ?? 0));
  const outputTokens = Math.max(0, input.usage?.output_tokens ?? 0);
  return {
    operation: input.operation,
    model: input.model,
    latencySeconds: Math.max(0, input.latencySeconds),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    estimatedCostUsd: estimateTextCostUsd(input.model, inputTokens, cachedInputTokens, outputTokens),
  };
}
