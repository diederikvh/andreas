/**
 * Minimale Bunny.net Storage upload-helper. Gebruikt hun REST-API
 * direct (HTTP PUT met AccessKey-header) — geen SDK nodig.
 *
 * Pad-conventie: `<bucket>/<file>.<ext>` (bv. `avatars/<userId>.jpg`).
 * Public URL = `${BUNNY_PULL_ZONE_URL}/<path>` (CDN).
 */

const STORAGE_HOST = 'https://storage.bunnycdn.com';

export async function uploadToBunny(
  path: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string
): Promise<string> {
  const zone = process.env.BUNNY_STORAGE_ZONE;
  const password = process.env.BUNNY_STORAGE_PASSWORD;
  const pullZone = process.env.BUNNY_PULL_ZONE_URL;
  if (!zone || !password || !pullZone) {
    throw new Error(
      'Bunny niet geconfigureerd (BUNNY_STORAGE_ZONE / _PASSWORD / _PULL_ZONE_URL)'
    );
  }

  const url = `${STORAGE_HOST}/${zone}/${path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: password,
      'Content-Type': contentType,
    },
    body: body as ArrayBuffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Bunny upload mislukt: ${res.status} ${text}`);
  }
  return `${pullZone.replace(/\/$/, '')}/${path}`;
}
