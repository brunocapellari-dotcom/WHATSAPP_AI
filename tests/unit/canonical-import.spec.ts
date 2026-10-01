import { describe, expect, it } from 'vitest';
import {
  CanonicalEntityImportSchema,
  normalizeCanonicalImport,
} from '../../src/freight/canonical-import.js';

describe('canonical entity import contract', () => {
  it('normalizes aliases and preserves external identifiers/provenance', () => {
    const row = normalizeCanonicalImport({
      entityId: 'company:rfb:12345678000190',
      entityType: 'COMPANY',
      canonicalName: 'Empresa Exemplo Ltda',
      aliases: ['EMPRESA EXEMPLO', 'Empresa   Exemplo Ltda'],
      externalIds: { cnpj: ' 12345678000190 ' },
      confidence: 1,
      source: {
        sourceId: 'rfb-cnpj-open-data',
        sourceName: 'Receita Federal - Dados Abertos CNPJ',
        referenceDate: '2026-09-01',
      },
    });

    expect(row.aliases).toEqual(['EMPRESA EXEMPLO', 'EMPRESA EXEMPLO LTDA']);
    expect(row.externalIds).toEqual({ cnpj: '12345678000190' });
    expect(row.source.sourceId).toBe('rfb-cnpj-open-data');
  });

  it('rejects malformed global entities before they reach PostgreSQL', () => {
    expect(() => CanonicalEntityImportSchema.parse({
      entityId: '../bad',
      entityType: 'COMPANY',
      canonicalName: '',
      source: {},
    })).toThrow();
  });

  it('allows CNPJ and RNTRC to remain textual identifiers', () => {
    const row = CanonicalEntityImportSchema.parse({
      entityId: 'carrier:antt:000000000',
      entityType: 'CARRIER',
      canonicalName: 'Transportadora Exemplo',
      externalIds: {
        rntrc: '000000000',
        cnpj: '12ABC678000190',
      },
      source: {
        sourceId: 'antt-rntrc',
        sourceName: 'ANTT RNTRC',
      },
    });
    expect(row.externalIds.rntrc).toBe('000000000');
    expect(row.externalIds.cnpj).toBe('12ABC678000190');
  });
});
