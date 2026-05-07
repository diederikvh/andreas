/**
 * Eenmalig: zet scraperConfig.ical voor de 5 high-confidence WordPress
 * iCal-venues (uit inventory.csv).
 */
import { eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

const CONFIGS: { slug: string; url: string }[] = [
  { slug: 'bajesdorp-grond', url: 'https://grond.community/events/?ical=1' },
  { slug: 'de-ateliers', url: 'https://www.de-ateliers.nl/agenda/?ical=1' },
  { slug: 'plantagedok', url: 'https://plantagedok.nl/events/?ical=1' },
  { slug: 'ru-pare', url: 'https://rupare.nl/events/?ical=1' },
  { slug: 'ruigoord', url: 'https://ruigoord.nl/programma/?ical=1' },
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
        ical: { url: cfg.url },
      },
    })
    .where(eq(schema.venues.id, venue.id));
  console.log(`✓ ${venue.name} → ${cfg.url}`);
}
process.exit(0);
