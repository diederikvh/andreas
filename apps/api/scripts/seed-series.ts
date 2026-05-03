/**
 * Idempotente seed voor de `series` tabel: ADE (cross-venue) +
 * Lenteballet (single-venue, meerdere zalen). Koppelt bestaande
 * seed-events aan deze series. Draait niet automatisch:
 *
 *   pnpm tsx --env-file=.env scripts/seed-series.ts
 *
 * Vereist dat `pnpm db:seed` al is gedraaid zodat de gerefereerde
 * event-IDs bestaan. Re-runnen is veilig: wist alleen series +
 * koppelingen.
 */

import { eq, inArray } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film';

type SeededSeries = {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  categories: Category[];
  eventIds: string[];
};

const SERIES: SeededSeries[] = [
  {
    id: 'series-ade-2026',
    slug: 'ade-2026',
    name: 'ADE 2026',
    description:
      'Amsterdam Dance Event 2026 — vijf dagen elektronische muziek verspreid over de stad.',
    imageUrl:
      'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=800&q=70&auto=format&fit=crop',
    categories: ['Muziek'],
    eventIds: ['evt-lewsberg', 'evt-future-islands', 'evt-sussie-solo'],
  },
  {
    id: 'series-lenteballet-2026',
    slug: 'lenteballet-2026',
    name: 'Lenteballet 2026',
    description:
      'Drie producties, drie zalen, één Frascati. Het jaarlijkse lenteprogramma.',
    imageUrl:
      'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=800&q=70&auto=format&fit=crop',
    categories: ['Theater'],
    eventIds: ['evt-de-wake', 'evt-moeders-oorlogspad', 'evt-de-meeuw'],
  },
];

// Verwijder bestaande koppelingen + series om idempotent te zijn.
await db.delete(schema.eventsInSeries).where(
  inArray(
    schema.eventsInSeries.seriesId,
    SERIES.map((s) => s.id)
  )
);
await db.delete(schema.series).where(
  inArray(
    schema.series.id,
    SERIES.map((s) => s.id)
  )
);

for (const s of SERIES) {
  // Bereken datum-range uit de daadwerkelijk bestaande events.
  const events = await db
    .select({
      id: schema.events.id,
      startsAt: schema.events.startsAt,
      endsAt: schema.events.endsAt,
    })
    .from(schema.events)
    .where(inArray(schema.events.id, s.eventIds));

  const found = events.map((e) => e.id);
  const missing = s.eventIds.filter((id) => !found.includes(id));
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`⚠ ${s.slug}: events niet gevonden — ${missing.join(', ')}`);
  }

  const startsAt =
    events.length > 0
      ? new Date(Math.min(...events.map((e) => e.startsAt.getTime())))
      : null;
  const endsAt =
    events.length > 0
      ? new Date(
          Math.max(
            ...events.map((e) => (e.endsAt ?? e.startsAt).getTime())
          )
        )
      : null;

  await db.insert(schema.series).values({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    imageUrl: s.imageUrl,
    startsAt,
    endsAt,
    categories: s.categories,
  });

  if (found.length > 0) {
    await db.insert(schema.eventsInSeries).values(
      found.map((eventId) => ({
        eventId,
        seriesId: s.id,
      }))
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `✓ ${s.slug} (${found.length} event${found.length === 1 ? '' : 's'})`
  );
}

// eslint-disable-next-line no-console
console.log(`\nSeeded ${SERIES.length} series.`);
process.exit(0);
