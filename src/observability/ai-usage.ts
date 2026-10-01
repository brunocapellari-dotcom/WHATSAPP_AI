export type AiUsageSample = {
  operation: string;
  model: string;
  latencySeconds: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
};

export type AiUsageObserver = (sample: AiUsageSample) => void;
