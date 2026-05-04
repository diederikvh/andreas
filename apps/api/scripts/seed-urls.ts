/**
 * Patcht alleen `website` + `instagram` voor bestaande venues op
 * basis van venues.json. Idempotent. Niet automatisch te draaien —
 * eenmalige update na de schema-migratie 0008.
 *
 *   pnpm tsx --env-file=.env scripts/seed-urls.ts
 */

import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const ID_OVERRIDE: Record<string, string> = { 'eye-filmmuseum': 'eye' };

function normalizeInstagram(value: string | null | undefined): string | null {
  if (!value) return null;
  const c = value
    .trim()
    .replace(/^@+/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  return c.length > 0 ? c : null;
}

const json = JSON.parse(
  await readFile(new URL('../../../venues.json', import.meta.url), 'utf-8')
) as { venues: Array<{ slug: string; website: string | null; instagram: string | null }> };

let n = 0;
for (const v of json.venues) {
  const id = ID_OVERRIDE[v.slug] ?? v.slug;
  const ig = normalizeInstagram(v.instagram);
  const result = await db
    .update(schema.venues)
    .set({ website: v.website ?? null, instagram: ig })
    .where(eq(schema.venues.id, id))
    .returning({ id: schema.venues.id });
  if (result.length > 0) n++;
}

// eslint-disable-next-line no-console
console.log(`Updated ${n} venues with website + instagram.`);
process.exit(0);
