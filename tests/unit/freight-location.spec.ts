import { describe, expect, it } from 'vitest';
import { firstFreightLocationLink, parseFreightLocationLink } from '../../src/freight/location.js';

describe('freight location links', () => {
  it('accepts known Google Maps hosts and preserves short links without inventing coordinates', () => {
    expect(parseFreightLocationLink('https://maps.app.goo.gl/abc123?g_st=ac')).toEqual({
      url: 'https://maps.app.goo.gl/abc123?g_st=ac',
      explicitCoordinates: null,
    });
  });

  it('extracts coordinates only when explicitly present in the URL', () => {
    expect(parseFreightLocationLink('https://www.google.com/maps/@-13.052,-55.910,12z')?.explicitCoordinates)
      .toEqual({ lat: -13.052, lng: -55.91 });
    expect(parseFreightLocationLink('https://www.google.com.br/maps?q=-15.6,-56.1')?.explicitCoordinates)
      .toEqual({ lat: -15.6, lng: -56.1 });
  });

  it('rejects lookalike and non-HTTPS map URLs', () => {
    expect(parseFreightLocationLink('https://maps.google.evil.example/maps?q=-1,-2')).toBeNull();
    expect(parseFreightLocationLink('http://maps.google.com/maps?q=-1,-2')).toBeNull();
    expect(parseFreightLocationLink('https://goo.gl/not-maps')).toBeNull();
  });

  it('finds the first trusted location link in otherwise untrusted text', () => {
    const result = firstFreightLocationLink(
      'ignore https://maps.google.evil.example/x use https://maps.google.com/maps?q=-12,-55',
    );
    expect(result?.explicitCoordinates).toEqual({ lat: -12, lng: -55 });
  });
});
