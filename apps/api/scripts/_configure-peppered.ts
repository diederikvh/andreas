import { eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Theater Bellevue + Bijlmer Parktheater zitten beide op het Peppered
 * SaaS-platform: identieke sitemap-shape (`/agenda/{slug}-{4char}`) en
 * JSON-LD `Event`-block per show-page (multi-night = meerdere blocks).
 * Past direct op de bestaande `theater.ts` scraper, alleen DB-config.
 */
type Cfg = { id: string; sitemapUrl: string; showUrlPattern: string };

const configs: Cfg[] = [
  {
    id: 'theater-bellevue',
    sitemapUrl: 'https://www.theaterbellevue.nl/sitemap.xml',
    showUrlPattern: '^https://www\\.theaterbellevue\\.nl/agenda/[a-z0-9-]+$',
  },
  {
    id: 'bijlmer-parktheater',
    sitemapUrl: 'https://bijlmerparktheater.nl/sitemap.xml',
    showUrlPattern: '^https://www\\.bijlmerparktheater\\.nl/agenda/[a-z0-9-]+$',
  },
];

// Verifieer venue-IDs eerst
const ids = configs.map((c) => c.id);
const found = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(inArray(schema.venues.id, ids));

const foundIds = new Set(found.map((v) => v.id));
for (const c of configs) {
  if (!foundIds.has(c.id)) console.log(`  ! venue-ID '${c.id}' NIET gevonden`);
}
console.log(`Bestaande venues:`);
for (const v of found) console.log(`  ${v.id} | ${v.name}`);
console.log();

for (const c of configs) {
  const venue = found.find((v) => v.id === c.id);
  if (!venue) continue;
  const next = {
    ...(venue.scraperConfig ?? {}),
    theater: {
      sitemapUrl: c.sitemapUrl,
      showUrlPattern: c.showUrlPattern,
    },
  };
  await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, c.id));
  console.log(`  + ${c.id} → theater config gezet`);
}
process.exit(0);
