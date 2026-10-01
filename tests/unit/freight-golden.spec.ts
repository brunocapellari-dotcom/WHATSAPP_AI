import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heuristicExtract } from '../../src/freight/extractor.js';

const corpus = JSON.parse(readFileSync(new URL('../fixtures/freight-golden.json', import.meta.url), 'utf8')) as Array<Record<string, unknown>>;

describe('freight golden extraction corpus', () => {
  it('meets deterministic extraction acceptance threshold for relevant fixtures', () => {
    let expected = 0;
    let correct = 0;
    for (const row of corpus) {
      if (row.irrelevant) continue;
      const fields = heuristicExtract(String(row.text));
      for (const key of ['product','origin','destination','freightValue','offerId'] as const) {
        if (!(key in row)) continue;
        expected++;
        if (fields[key].value === row[key]) correct++;
      }
    }
    expect(correct / expected).toBeGreaterThanOrEqual(0.95);
  });
});
