/**
 * Artist-detail endpoint. Eén artist per slug, met streaming-links +
 * komende events waar 'ie in de lineup voorkomt.
 *
 * Geen pagineerde lijst-endpoint hier — discovery van artists gaat
 * altijd via een event-detail (klik op een lineup-item). De artist-
 * pagina is een aanlandpunt, geen index.
 */

import { Hono } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';

export const artistsRoute = new Hono();

artistsRoute.get('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const [artist] = await db
    .select()
    .from(schema.artists)
    .where(eq(schema.artists.id, slug))
    .limit(1);
  if (!artist) return c.json({ error: 'artist not found' }, 404);

  // Komende events waar deze artist in de lineup staat. JSONB
  // containment-check op de artistId-key. Index `occurrences_lineup_
  // gin_idx` versnelt dit. We groeperen per eventId zodat een
  // residency niet 5x in de lijst staat.
  const upcomingRows = await db
    .select({
      eventId: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      posterUrl: schema.events.posterUrl,
      stillUrl: schema.events.stillUrl,
      category: schema.events.category,
      occId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      venueId: schema.venues.id,
      venueSlug: schema.venues.slug,
      venueName: schema.venues.name,
      venueType: schema.venues.type,
    })
    .from(schema.occurrences)
    .innerJoin(schema.events, eq(schema.events.id, schema.occurrences.eventId))
    .innerJoin(schema.venues, eq(schema.venues.id, schema.events.venueId))
    .where(
      and(
        eq(schema.events.category, 'Muziek'),
        gte(schema.occurrences.startsAt, sql`NOW()`),
        sql`${schema.occurrences.lineup} @> ${JSON.stringify([{ artistId: artist.id }])}::jsonb`
      )
    )
    .orderBy(schema.occurrences.startsAt);

  // Dedup per eventId — pak de vroegste occurrence als
  // representatief moment voor in de lijst.
  const seenEvents = new Set<string>();
  const events = [];
  for (const r of upcomingRows) {
    if (seenEvents.has(r.eventId)) continue;
    seenEvents.add(r.eventId);
    events.push({
      id: r.eventId,
      title: r.title,
      imageUrl: r.imageUrl,
      posterUrl: r.posterUrl,
      stillUrl: r.stillUrl,
      category: r.category,
      nextOccurrence: {
        id: r.occId,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
      },
      venue: {
        id: r.venueId,
        slug: r.venueSlug,
        name: r.venueName,
        type: r.venueType,
      },
    });
  }

  return c.json({
    artist: {
      id: artist.id,
      name: artist.name,
      description: artist.description,
      imageUrl: artist.imageUrl,
      spotifyUrl: artist.spotifyUrl,
      appleMusicUrl: artist.appleMusicUrl,
      bandcampUrl: artist.bandcampUrl,
      youtubeUrl: artist.youtubeUrl,
      officialUrl: artist.officialUrl,
      genres: artist.genres,
    },
    events,
  });
});
