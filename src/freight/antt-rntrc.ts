import type { CanonicalEntityImport } from './canonical-import.js';
import { normalizeEntityText } from './entity-resolution.js';

export type AnttRntrcRecord = {
  nome_transportador?: unknown;
  numero_rntrc?: unknown;
  situacao_rntrc?: unknown;
  cpfcnpjtransportador?: unknown;
  categoria_transportador?: unknown;
  municipio?: unknown;
  uf?: unknown;
  data_primeiro_cadastro?: unknown;
  data_situacao_rntrc?: unknown;
};

export type AnttRntrcSource = {
  resourceId: string;
  resourceName: string;
  sourceUrl: string;
  referenceDate?: string;
  publicationDate?: string;
  collectedAt: string;
};

export type AnttTransformResult =
  | { entity: CanonicalEntityImport; skipReason?: never }
  | { entity?: never; skipReason: 'inactive' | 'individual' | 'missing_name' | 'missing_rntrc' };

function stringValue(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function organizationIdentifier(value: unknown): string | null {
  const normalized = stringValue(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // CPF has 11 positions. CNPJ, including the alphanumeric format, has 14.
  return /^[A-Z0-9]{14}$/.test(normalized) ? normalized : null;
}

function rntrcIdentifier(value: unknown): string | null {
  const normalized = stringValue(value).replace(/[^0-9]/g, '');
  return normalized ? normalized : null;
}

function isActive(value: unknown): boolean {
  return normalizeEntityText(stringValue(value)) === 'ATIVO';
}

export function rntrcRecordToCanonical(
  row: AnttRntrcRecord,
  source: AnttRntrcSource,
): AnttTransformResult {
  if (!isActive(row.situacao_rntrc)) {
    return { skipReason: 'inactive' };
  }

  const cnpj = organizationIdentifier(row.cpfcnpjtransportador);
  if (!cnpj) {
    // Deliberately exclude TAC/CPF from the global catalog to minimize PII.
    return { skipReason: 'individual' };
  }

  const name = stringValue(row.nome_transportador);
  if (!name) return { skipReason: 'missing_name' };

  const rntrc = rntrcIdentifier(row.numero_rntrc);
  if (!rntrc) return { skipReason: 'missing_rntrc' };

  const category = stringValue(row.categoria_transportador);
  const municipality = stringValue(row.municipio);
  const uf = stringValue(row.uf).toUpperCase();

  const aliases = [name, cnpj, rntrc];
  if (municipality && uf) aliases.push(`${name} ${municipality} ${uf}`);

  return {
    entity: {
      entityId: `carrier:antt:rntrc:${rntrc}`,
      entityType: 'CARRIER',
      canonicalName: name,
      aliases,
      externalIds: {
        rntrc,
        cnpj,
        ...(category ? { rntrcCategory: category } : {}),
        ...(municipality ? { municipality } : {}),
        ...(uf ? { uf } : {}),
        ...(row.data_primeiro_cadastro
          ? { firstRegistrationDate: stringValue(row.data_primeiro_cadastro) }
          : {}),
        ...(row.data_situacao_rntrc
          ? { rntrcStatusDate: stringValue(row.data_situacao_rntrc) }
          : {}),
      },
      confidence: 1,
      source: {
        sourceId: `ANTT_RNTRC:${source.resourceId}`,
        sourceName: `ANTT RNTRC — ${source.resourceName}`,
        sourceUrl: source.sourceUrl,
        ...(source.referenceDate ? { referenceDate: source.referenceDate } : {}),
        ...(source.publicationDate ? { publicationDate: source.publicationDate } : {}),
        collectedAt: source.collectedAt,
        license: 'Creative Commons Atribuição',
      },
    },
  };
}
