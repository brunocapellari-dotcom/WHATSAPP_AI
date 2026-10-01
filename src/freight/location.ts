const ALLOWED_MAP_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'maps.google.com.br',
  'www.google.com.br',
]);

export type FreightLocationLink = {
  url: string;
  explicitCoordinates: { lat: number; lng: number } | null;
};

function validCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat)
    && Number.isFinite(lng)
    && lat >= -90
    && lat <= 90
    && lng >= -180
    && lng <= 180;
}

function coordinatesFromUrl(url: URL): { lat: number; lng: number } | null {
  const pathMatch = url.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (pathMatch) {
    const lat = Number(pathMatch[1]);
    const lng = Number(pathMatch[2]);
    if (validCoordinate(lat, lng)) return { lat, lng };
  }

  for (const key of ['q', 'query']) {
    const value = url.searchParams.get(key);
    const match = value?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (validCoordinate(lat, lng)) return { lat, lng };
  }

  return null;
}

export function parseFreightLocationLink(raw: string): FreightLocationLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_MAP_HOSTS.has(host)) return null;
  if (host === 'goo.gl' && !url.pathname.toLowerCase().startsWith('/maps')) return null;

  return {
    url: url.toString(),
    explicitCoordinates: coordinatesFromUrl(url),
  };
}

export function firstFreightLocationLink(text: string): FreightLocationLink | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const parsed = parseFreightLocationLink(match[0]);
    if (parsed) return parsed;
  }
  return null;
}
