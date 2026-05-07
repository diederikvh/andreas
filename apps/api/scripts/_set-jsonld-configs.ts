/** Eenmalig: zet scraperConfig.jsonld voor de 5 high-confidence venues. */
import { eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Cat = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';

const CONFIGS: { slug: string; url: string; categories?: Cat[] }[] = [
  // Filmtheaters: rijke @graph van ScreeningEvent's per dag.
  { slug: 'kriterion', url: 'https://kriterion.nl/programma-vandaag', categories: ['Film'] },
  { slug: 'filmhallen', url: 'https://filmhallen.nl', categories: ['Film'] },
  { slug: 'the-movies', url: 'https://themovies.nl', categories: ['Film'] },
  // Club: events op de homepage met startDate/url.
  { slug: 'lofi', url: 'https://lofi.amsterdam', categories: ['Muziek'] },
  // Galerie: tentoonstellingen + openings op /events.
  { slug: 'w139', url: 'https://w139.nl/events', categories: ['Kunst'] },
];

const venues = await db
  .select()
  .from(schema.venues)
  .where(
    inArray(
      schema.venues.slug,
      CONFIGS.map((c) => c.slug)
    )
  );

const found = new Set(venues.map((v) => v.slug));
const missing = CONFIGS.filter((c) => !found.has(c.slug)).map((c) => c.slug);
if (missing.length > 0) {
  console.error(`✗ venues niet gevonden: ${missing.join(', ')}`);
  process.exit(1);
}

for (const cfg of CONFIGS) {
  const venue = venues.find((v) => v.slug === cfg.slug)!;
  await db
    .update(schema.venues)
    .set({
      scraperConfig: {
        ...(venue.scraperConfig ?? {}),
        jsonld: { url: cfg.url },
      },
      ...(cfg.categories ? { categories: cfg.categories } : {}),
    })
    .where(eq(schema.venues.id, venue.id));
  console.log(
    `✓ ${venue.name.padEnd(15)} → ${cfg.url}` +
      (cfg.categories ? `   cats=${JSON.stringify(cfg.categories)}` : '')
  );
}
process.exit(0);
