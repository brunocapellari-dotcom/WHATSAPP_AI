import type { FreightFields } from '../domain/schemas.js';
import { sha256 } from '../security/crypto.js';

export type FreightIdentity = {
  fingerprint: string;
  strength: 'OFFER_ID' | 'STRUCTURED' | 'WEAK';
  eventEligible: boolean;
};

function norm(value: string | number | null): string {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function freightIdentity(input: {
  fields: FreightFields;
  contentHash: string;
  canonical: {
    productId: string | null;
    originId: string | null;
    destinationId: string | null;
  };
}): FreightIdentity {
  const { fields, contentHash, canonical } = input;

  if (fields.offerId.value) {
    return {
      fingerprint: sha256(`offer:${norm(fields.offerId.value)}`),
      strength: 'OFFER_ID',
      eventEligible: true,
    };
  }

  const hasRoute = Boolean(canonical.originId && canonical.destinationId);
  const hasProduct = Boolean(canonical.productId);
  const hasPrice = fields.freightValue.value != null;
  const hasPeriod = Boolean(fields.loadingDate.value || fields.loadingWindow.value);

  if (hasRoute && hasProduct && (hasPrice || hasPeriod)) {
    const roundedPrice = fields.freightValue.value == null
      ? null
      : Math.round(fields.freightValue.value * 100) / 100;

    const parts = [
      canonical.productId,
      canonical.originId,
      canonical.destinationId,
      norm(roundedPrice),
      norm(fields.freightUnit.value),
      norm(fields.loadingDate.value),
      norm(fields.loadingWindow.value),
    ];

    return {
      fingerprint: sha256(`structured:${parts.join('|')}`),
      strength: 'STRUCTURED',
      eventEligible: true,
    };
  }

  return {
    fingerprint: sha256(`weak:${contentHash}`),
    strength: 'WEAK',
    eventEligible: false,
  };
}

export function freightFingerprint(fields: FreightFields): string {
  if (fields.offerId.value) return sha256(`offer:${norm(fields.offerId.value)}`);
  const parts = [
    norm(fields.product.value),
    norm(fields.origin.value),
    norm(fields.destination.value),
    norm(fields.freightValue.value == null ? null : Math.round(fields.freightValue.value * 100) / 100),
    norm(fields.freightUnit.value),
    norm(fields.loadingDate.value),
    norm(fields.loadingWindow.value),
  ];
  return sha256(`legacy:${parts.join('|')}`);
}
