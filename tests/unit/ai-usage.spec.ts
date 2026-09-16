import { describe, expect, it } from 'vitest';
import { estimateTextCostUsd, responseUsageSample } from '../../src/observability/ai-usage.js';

describe('AI usage accounting', () => {
  it('accounts for Terra cached and uncached tokens with the versioned price table', () => {
    const cost = estimateTextCostUsd('gpt-5.6-terra', 1_000_000, 250_000, 100_000);
    // 750k * $2/M + 250k * $0.20/M + 100k * $12/M
    // Long-context pricing applies because total input is >272k: input rates x2, output x1.5.
    expect(cost).toBeCloseTo(5.85, 8);
  });

  it('does not invent a cost for unknown models', () => {
    expect(estimateTextCostUsd('future-model', 100, 0, 10)).toBeUndefined();
  });

  it('clamps cached tokens to total input', () => {
    const sample = responseUsageSample({
      operation: 'test',
      model: 'gpt-5.6-terra',
      latencySeconds: 0.5,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 10 },
    });
    expect(sample.cachedInputTokens).toBe(100);
    expect(sample.inputTokens).toBe(100);
    expect(sample.estimatedCostUsd).toBeCloseTo(0.00014, 8);
  });
});
