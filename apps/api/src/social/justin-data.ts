import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/**
 * Bouwt de DailyJustIn5-props uit de DB: events met `createdAt` binnen
 * de laatste 7 dagen, sorteer nieuwste eerst, 5 picks. Gedeeld tussen
 * de UI-knop en de JSON-endpoint zodat beide identieke data hebben.
 */
export interface JustInProps {
  totalNewCount: number;
  hook: string;
  audio: string;
  picks: Array<{
    imageUrl: string;
    title: string;
    venueName: string;
    category: string;
    dateLabel: string;
    daysAgo: number;
  }>;
}

function formatDateLabel(d: Date): string {
  const days = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const months = [
    'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
    'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
  ];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

export async function fetchJustInPropsForUi(): Promise<JustInProps> {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        gte(schema.events.createdAt, since),
      ),
    );
  const totalNewCount = totalRow[0]?.n ?? 0;

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      category: schema.events.category,
      createdAt: schema.events.createdAt,
      venueName: schema.venues.name,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        gte(schema.events.createdAt, since),
        isNotNull(schema.events.imageUrl),
      ),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(6);
  if (rows.length < 6) {
    throw new Error(`minder dan 6 nieuwe events deze week (${rows.length})`);
  }

  // Eerstvolgende occurrence per event ophalen voor de event-datum.
  const occRows = await db
    .select({
      eventId: schema.occurrences.eventId,
      startsAt: schema.occurrences.startsAt,
    })
    .from(schema.occurrences)
    .where(
      and(
        inArray(
          schema.occurrences.eventId,
          rows.map((r) => r.id),
        ),
        gte(schema.occurrences.startsAt, now),
      ),
    )
    .orderBy(asc(schema.occurrences.startsAt));
  const firstOccByEvent = new Map<string, Date>();
  for (const o of occRows) {
    if (!firstOccByEvent.has(o.eventId)) {
      firstOccByEvent.set(o.eventId, o.startsAt);
    }
  }

  const picks = rows.map((r) => {
    const eventDate = firstOccByEvent.get(r.id) ?? r.createdAt;
    return {
      imageUrl: r.imageUrl!,
      title: r.title,
      venueName: r.venueName,
      category: r.category,
      dateLabel: formatDateLabel(eventDate),
      daysAgo: Math.max(
        0,
        Math.floor(
          (now.getTime() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      ),
    };
  });

  return {
    totalNewCount,
    hook: 'Net aangekondigd in Amsterdam',
    audio: 'audio/justin.mp3',
    picks,
  };
}
