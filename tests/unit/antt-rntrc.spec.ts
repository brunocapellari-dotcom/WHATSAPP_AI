import { describe, expect, it } from 'vitest';
import { rntrcRecordToCanonical } from '../../src/freight/antt-rntrc.js';

const source = {
  resourceId: 'ce319c77-342c-4c35-87fa-a15a9f1bec03',
  resourceName: 'Ago26 - RNTRC',
  sourceUrl: 'https://dados.antt.gov.br/dataset/rntrc/resource/ce319c77-342c-4c35-87fa-a15a9f1bec03',
  referenceDate: '2026-08-01',
  publicationDate: '2026-09-10',
  collectedAt: '2026-09-28T20:00:00.000Z',
};

describe('ANTT RNTRC canonical transform', () => {
  it('imports an active organization as a CARRIER with provenance', () => {
    const result = rntrcRecordToCanonical({
      nome_transportador: 'Transportadora Exemplo Ltda',
      numero_rntrc: 12345678,
      situacao_rntrc: 'ATIVO',
      cpfcnpjtransportador: '12.345.678/0001-90',
      categoria_transportador: 'ETC',
      municipio: 'Rondonópolis',
      uf: 'MT',
      data_primeiro_cadastro: '2020-01-02',
      data_situacao_rntrc: '2026-08-31',
    }, source);

    expect(result.entity).toMatchObject({
      entityId: 'carrier:antt:rntrc:12345678',
      entityType: 'CARRIER',
      canonicalName: 'Transportadora Exemplo Ltda',
      externalIds: {
        rntrc: '12345678',
        cnpj: '12345678000190',
        rntrcCategory: 'ETC',
        municipality: 'Rondonópolis',
        uf: 'MT',
      },
      source: {
        sourceId: 'ANTT_RNTRC:ce319c77-342c-4c35-87fa-a15a9f1bec03',
        referenceDate: '2026-08-01',
        publicationDate: '2026-09-10',
      },
    });
    expect(result.entity?.aliases).toContain('12.345.678/0001-90');
  });

  it('accepts a 14-position alphanumeric CNPJ as text', () => {
    const result = rntrcRecordToCanonical({
      nome_transportador: 'Transportadora Alfanumérica',
      numero_rntrc: '998877',
      situacao_rntrc: 'ATIVO',
      cpfcnpjtransportador: 'AB.CDE.123/0001-FG',
      categoria_transportador: 'ETC',
    }, source);

    expect(result.entity?.externalIds.cnpj).toBe('ABCDE1230001FG');
  });

  it('excludes CPF/TAC-like personal identifiers from the global catalog', () => {
    const result = rntrcRecordToCanonical({
      nome_transportador: 'Pessoa Física',
      numero_rntrc: '123',
      situacao_rntrc: 'ATIVO',
      cpfcnpjtransportador: '123.456.789-01',
      categoria_transportador: 'TAC',
    }, source);

    expect(result).toEqual({ skipReason: 'individual' });
  });

  it('excludes inactive registrations', () => {
    const result = rntrcRecordToCanonical({
      nome_transportador: 'Empresa Inativa',
      numero_rntrc: '456',
      situacao_rntrc: 'INATIVO',
      cpfcnpjtransportador: '12345678000190',
      categoria_transportador: 'ETC',
    }, source);

    expect(result).toEqual({ skipReason: 'inactive' });
  });
});
