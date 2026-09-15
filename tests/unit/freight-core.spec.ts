import { describe, expect, it } from 'vitest';
import { CanonicalEntityResolver } from '../../src/freight/entity-resolution.js';
import { heuristicExtract } from '../../src/freight/extractor.js';
import { freightFingerprint } from '../../src/freight/dedup.js';

describe('freight core', () => {
  it('resolves Rondonópolis aliases to one canonical entity', async () => {
    const resolver = new CanonicalEntityResolver();
    const a = await resolver.resolveCity('Roo');
    const b = await resolver.resolveCity('Rondonópolis/MT');
    expect(a?.id).toBe(b?.id);
  });

  it('preserves field-level truth classification as observed for explicit fields', () => {
    const fields = heuristicExtract('SOJA\nOrigem: Sinop/MT\nDestino: Rondonópolis/MT\nFrete R$ 175,50');
    expect(fields.product.truth).toBe('OBSERVADO');
    expect(fields.freightValue.truth).toBe('OBSERVADO');
    expect(fields.freightValue.value).toBe(175.5);
  });

  it('uses offer id as strongest dedup key', () => {
    const a = heuristicExtract('SOJA\nOrigem: Sinop\nDestino: Roo\nFrete R$ 170\nOferta: ABC123');
    const b = heuristicExtract('MILHO\nOrigem: Sorriso\nDestino: Santos\nFrete R$ 999\nOferta: ABC123');
    expect(freightFingerprint(a)).toBe(freightFingerprint(b));
  });
});
