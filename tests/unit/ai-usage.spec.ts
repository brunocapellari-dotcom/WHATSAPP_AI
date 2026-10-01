import { describe, expect, it } from 'vitest';
import { estimateTextCostUsd, responseUsageSample } from '../../src/observability/ai-usage.js';

describe('AI usage accounting', () => {
  it('accounts for Terra cached and uncached tokens with long-context pricing', () => {
    const cost = estimateTextCostUsd('gpt-5.6-terra', 1_000_000, 250_000, 100_000);
    // Long-context pricing (>272k input): input rates x2 and output rate x1.5.
    // 750k uncached = $3.00; 250k cached = $0.10; 100k output = $1.80.
    expect(cost).toBeCloseTo(4.9, 8);
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
