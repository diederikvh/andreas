/**
 * One-off: iCal-events opnieuw door Claude-enrich halen om category +
 * genres te corrigeren. Voor de eerste batch iCal-scrapes stond
 * category nog op de venue-fallback (Muziek by default), wat voor
 * kunst-venues zoals De Ateliers fout uitpakte.
 *
 *   pnpm tsx --env-file=.env scripts/_recategorize-ical.ts
 *
 * Idempotent — events worden alleen ge-update als de nieuwe category
 * verschilt van de huidige.
 */
import { eq, like } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';
import { enrichEvent } from '../src/scrapers/enrich.js';

const events = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    description: schema.events.description,
    category: schema.events.category,
    genres: schema.events.genres,
    venueId: schema.events.venueId,
  })
  .from(schema.events)
  .where(like(schema.events.id, 'evt-ical-%'));

console.log(`${events.length} iCal-events gevonden\n`);

const venuesById = new Map(
  (await db.select().from(schema.venues)).map((v) => [v.id, v])
);

let touched = 0;
let unchanged = 0;
for (const e of events) {
  const venue = venuesById.get(e.venueId);
  if (!venue) continue;
  const enriched = await enrichEvent({
    title: e.title,
    description: e.description,
    venueName: venue.name,
    venueCategory: venue.categories?.[0] ?? 'Muziek',
  });
  const newCategory = enriched.category ?? e.category;
  const newGenres =
    e.genres.length === 0 && enriched.genres.length > 0
      ? enriched.genres
      : e.genres;

  if (newCategory !== e.category || newGenres !== e.genres) {
    await db
      .update(schema.events)
      .set({ category: newCategory, genres: newGenres })
      .where(eq(schema.events.id, e.id));
    console.log(
      `  ✓ ${venue.name.padEnd(20)} ${e.category} → ${newCategory}  ${
        newGenres !== e.genres ? `genres=${JSON.stringify(newGenres)}` : ''
      }   ${e.title.slice(0, 60)}`
    );
    touched++;
  } else {
    unchanged++;
  }
}

console.log(
  `\n${touched} events ge-update, ${unchanged} ongewijzigd, ${events.length} totaal.`
);
process.exit(0);
