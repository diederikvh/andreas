import { and, eq, like, sql } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

/**
 * Cleanup van Concertgebouw-events met de oude eventId-shape (URL-slug
 * mét numeric prefix). Eerder werd elke voorstelling een eigen event
 * doordat Concertgebouw URLs zoals `45471300-lumi-basement-sessions`
 * gebruikt — elke avond heeft 'n eigen numeric-id in de URL maar slaat
 * terug op hetzelfde concert.
 *
 * Strategy: delete ALLES → laat de gefixte theater-scraper (met
 * `showSlugStripPattern: '^\d+-'`) vers genereren met de juiste
 * eventIds. Cleanest state — geen orphan events, geen subtle merges.
 *
 * Saves cascaden via FK weg. Voor Concertgebouw is dat OK — events
 * zijn vers ingeladen, geen user-saves erop.
 */

type EvRow = { id: string; title: string };

const evs = (await db
  .select({ id: schema.events.id, title: schema.events.title })
  .from(schema.events)
  .where(
    and(
      eq(schema.events.venueId, 'het-concertgebouw'),
      like(schema.events.id, 'evt-th-%')
    )
  )) as EvRow[];

console.log(`Te verwijderen Concertgebouw theater-events: ${evs.length}`);

const dryRun = !process.argv.includes('--apply');
if (dryRun) {
  console.log('\nDry-run. Voeg --apply toe om daadwerkelijk te verwijderen.');
  console.log('Daarna: scripts/scrape.ts theater --venue het-concertgebouw');
  process.exit(0);
}

let deleted = 0;
for (const e of evs) {
  await db.delete(schema.events).where(eq(schema.events.id, e.id));
  deleted++;
}
console.log(`\nVerwijderd: ${deleted} events (occurrences/saves cascadeden mee).`);

const after = (await db.execute(
  sql`SELECT count(*)::int as n FROM events WHERE venue_id = 'het-concertgebouw'`
)) as unknown as { rows: Array<{ n: number }> };
console.log(`Concertgebouw events na cleanup: ${after.rows?.[0]?.n}`);

process.exit(0);
