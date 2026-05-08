import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { auth } from '../auth.js';
import { db, schema } from '../db/index.js';

async function requireUserId(c: Context): Promise<string | Response> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'unauthorized' }, 401);
  return session.user.id;
}

export const socialRoute = new Hono();

const FEED_FRIENDS_PILL_LIMIT = 3;
const FEED_LIMIT = 50;

/**
 * Sociale activity-feed: events die ≥1 vriend(in) heeft gered, gesorteerd
 * op meest-recente save-tijd per event (gededupeerd). Eén rij per event,
 * met de vrienden-pill die naar de lijst van saved-friends wijst en de
 * `lastSavedAt` als relatieve "X dagen geleden"-label.
 *
 * Bewust _geen_ algoritme — sortering is puur "wie heeft net wat gered",
 * geen ranking op interacties of populariteit. Past bij het anti-feed-
 * idee waarmee Andreas is opgezet: zien wat vrienden(-van-vrienden) doen,
 * niet zien wat een algoritme denkt dat je leuk vindt.
 *
 * Privacy: vrienden met `savesVisibility='private'` worden uitgesloten,
 * zelfde gate als de friend-pills elders in de app.
 *
 * Foto-posts (later) komen als tweede content-type in dezelfde feed,
 * gesorteerd op `postedAt` in dezelfde stream — vandaar dat we nu al
 * een homogene "activity"-shape teruggeven met `lastSavedAt` als
 * sort-key. De UI hoeft straks alleen een nieuw item-type te leren
 * herkennen.
 */
socialRoute.get('/feed', async (c) => {
  const userId = await requireUserId(c);
  if (typeof userId !== 'string') return userId;

  // Stap 1 — alle accepted friend-IDs.
  const friendships = await db
    .select({
      fromUserId: schema.friendships.fromUserId,
      toUserId: schema.friendships.toUserId,
    })
    .from(schema.friendships)
    .where(
      and(
        eq(schema.friendships.status, 'accepted'),
        or(
          eq(schema.friendships.fromUserId, userId),
          eq(schema.friendships.toUserId, userId)
        )
      )
    );
  const friendIds = friendships.map((f) =>
    f.fromUserId === userId ? f.toUserId : f.fromUserId
  );
  if (friendIds.length === 0) return c.json({ events: [] });

  // Stap 2 — alle saves van vrienden, met privacy-gate. Joint events
  // + venues + occurrences mee zodat we in één query alles hebben dat
  // de mobile-feed-rij toont.
  const rows = await db
    .select({
      // event
      eventId: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      kind: schema.events.kind,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      featured: schema.events.featured,
      genres: schema.events.genres,
      // occurrence (gedenormaliseerd: het moment dat de vriend gered heeft)
      occurrenceId: schema.occurrences.id,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
      priceCents: schema.occurrences.priceCents,
      priceNote: schema.occurrences.priceNote,
      ticketUrl: schema.occurrences.ticketUrl,
      // venue
      venueId: schema.venues.id,
      venueSlug: schema.venues.slug,
      venueName: schema.venues.name,
      venueAddress: schema.venues.address,
      venueLat: schema.venues.lat,
      venueLng: schema.venues.lng,
      venueType: schema.venues.type,
      venueImageUrl: schema.venues.imageUrl,
      venuePriceNote: schema.venues.priceNote,
      // de vriend die saved
      friendId: schema.users.id,
      friendName: schema.users.name,
      friendHandle: schema.users.handle,
      friendAvatar: schema.users.avatarUrl,
      savedAt: schema.saves.createdAt,
    })
    .from(schema.saves)
    .innerJoin(schema.users, eq(schema.users.id, schema.saves.userId))
    .innerJoin(
      schema.occurrences,
      eq(schema.saves.occurrenceId, schema.occurrences.id)
    )
    .innerJoin(schema.events, eq(schema.occurrences.eventId, schema.events.id))
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        inArray(schema.saves.userId, friendIds),
        eq(schema.users.savesVisibility, 'friends'),
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        // Alleen saves waarvan het moment (occurrence) nog in de
        // toekomst valt — geen "Roos heeft 3 maanden geleden iets
        // gered dat allang voorbij is". Default duur 4u (zelfde
        // heuristiek als findEventsWithOccurrencesInRange) zodat
        // events zonder endsAt netjes wegvallen kort na de starttijd.
        sql`COALESCE(${schema.occurrences.endsAt}, ${schema.occurrences.startsAt} + INTERVAL '4 hours') >= NOW()`,
        sql`${schema.occurrences.status} <> 'cancelled'`
      )
    )
    .orderBy(desc(schema.saves.createdAt));

  if (rows.length === 0) return c.json({ events: [] });

  // Stap 3 — groepeer per event-ID, dedupe op friend-id (een vriend
  // die meerdere occurrences van hetzelfde event saved telt 1×). De
  // eerste rij per event-ID heeft de meest-recente save-tijd (dankzij
  // orderBy desc). Daarom houden we per event de *eerste* venue/
  // occurrence-rij vast — dat is "waar deze feed-rij over gaat".
  type FriendBadge = {
    id: string;
    name: string;
    handle: string | null;
    avatarUrl: string | null;
  };
  type FeedEntry = {
    eventId: string;
    title: string;
    description: string | null;
    kind: typeof schema.events.kind.enumValues[number];
    imageUrl: string | null;
    category: typeof schema.events.category.enumValues[number];
    featured: boolean;
    genres: string[];
    venue: {
      id: string;
      slug: string;
      name: string;
      address: string;
      lat: number;
      lng: number;
      type: typeof schema.venues.type.enumValues[number] | null;
      imageUrl: string | null;
      priceNote: string | null;
    };
    occurrence: {
      id: string;
      startsAt: Date;
      endsAt: Date | null;
      priceCents: number | null;
      priceNote: string | null;
      ticketUrl: string | null;
    };
    friendsSaved: FriendBadge[];
    friendsSavedCount: number;
    lastSavedAt: Date;
  };
  const byEvent = new Map<string, FeedEntry>();
  const friendIdsSeenPerEvent = new Map<string, Set<string>>();
  for (const r of rows) {
    let entry = byEvent.get(r.eventId);
    const seen =
      friendIdsSeenPerEvent.get(r.eventId) ?? new Set<string>();
    if (!entry) {
      entry = {
        eventId: r.eventId,
        title: r.title,
        description: r.description,
        kind: r.kind,
        imageUrl: r.imageUrl,
        category: r.category,
        featured: r.featured,
        genres: r.genres ?? [],
        venue: {
          id: r.venueId,
          slug: r.venueSlug,
          name: r.venueName,
          address: r.venueAddress,
          lat: r.venueLat,
          lng: r.venueLng,
          type: r.venueType,
          imageUrl: r.venueImageUrl,
          priceNote: r.venuePriceNote,
        },
        occurrence: {
          id: r.occurrenceId,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          priceCents: r.priceCents,
          priceNote: r.priceNote,
          ticketUrl: r.ticketUrl,
        },
        friendsSaved: [],
        friendsSavedCount: 0,
        lastSavedAt: r.savedAt,
      };
      byEvent.set(r.eventId, entry);
      friendIdsSeenPerEvent.set(r.eventId, seen);
    }
    if (seen.has(r.friendId)) continue;
    seen.add(r.friendId);
    entry.friendsSavedCount += 1;
    if (entry.friendsSaved.length < FEED_FRIENDS_PILL_LIMIT) {
      entry.friendsSaved.push({
        id: r.friendId,
        name: r.friendName,
        handle: r.friendHandle,
        avatarUrl: r.friendAvatar,
      });
    }
  }

  // Stap 4 — sorteer events op meest-recente save-tijd, cap op FEED_LIMIT.
  const events = Array.from(byEvent.values())
    .sort((a, b) => b.lastSavedAt.getTime() - a.lastSavedAt.getTime())
    .slice(0, FEED_LIMIT);

  return c.json({ events });
});
