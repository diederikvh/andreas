import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  formatWindowRange,
  withDynamicCount,
  withDynamicDate,
  type HookUnit,
} from './dailyfilms5-data.js';

/**
 * Bouwt de DailyJustIn5-props uit de DB: events met `createdAt` binnen
 * de laatste 7 dagen, sorteer nieuwste eerst, 6 picks. Gedeeld tussen
 * de UI-knop en de JSON-endpoint zodat beide identieke data hebben.
 *
 * Urgentie-framing: matches news-ticker stijl — "JUST IN · NIEUW",
 * dagsmarker per pick zodat "kaartjes regelen voor het uitverkocht is"
 * voelbaar is.
 */
export interface JustInProps {
  totalNewCount: number;
  hook: string;
  /** Gestructureerde intro-hook (zelfde shape als DailyFilms5). */
  hookUnits: HookUnit[];
  /** Eén-regelige titel boven de Overview-slide. */
  overviewTitle: string;
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

  // Hook-units in news-ticker stijl: [JUST IN][NIEUW] + count + zin + datum.
  const baseUnits: HookUnit[] = [
    { role: 'eyebrow', text: 'JUST IN' },
    { role: 'countLead', text: 'NIEUW' },
    { role: 'count', text: String(picks.length) },
    { role: 'headline', text: 'shows aangekondigd' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ];
  const dateRange = formatWindowRange(1, now); // vandaag — single date
  const hookUnits = withDynamicDate(
    withDynamicCount(baseUnits, picks.length),
    dateRange,
  );

  return {
    totalNewCount,
    hook: 'Net aangekondigd in Amsterdam',
    hookUnits,
    overviewTitle: `Top ${picks.length} net aangekondigd`,
    audio: 'audio/justin.mp3',
    picks,
  };
}

/**
 * Variant voor de carousel-renderer: levert dezelfde 6 picks maar met
 * richer velden (startsAt als Date, eventId, venueType, category) zodat
 * renderCarousel + CarouselPick-shape gevuld kan worden, plus de
 * dynamische hookUnits + overviewTitle uit dezelfde bron. Hergebruikt
 * de query-logica van fetchJustInPropsForUi.
 */
export interface JustInCarouselData {
  hookUnits: HookUnit[];
  overviewTitle: string;
  /** "do 6 jun" — gebruikt in intro-meta. */
  dateLabel: string;
  picks: Array<{
    eventId: string;
    imageUrl: string;
    title: string;
    venueName: string;
    venueType: string | null;
    category: string;
    startsAt: Date;
    endsAt: Date | null;
    daysAgo: number;
  }>;
}

export async function fetchJustInCarouselData(): Promise<JustInCarouselData> {
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      imageUrl: schema.events.imageUrl,
      venueImageUrl: schema.venues.imageUrl,
      category: schema.events.category,
      createdAt: schema.events.createdAt,
      venueName: schema.venues.name,
      venueType: schema.venues.type,
    })
    .from(schema.events)
    .innerJoin(schema.venues, eq(schema.events.venueId, schema.venues.id))
    .where(
      and(
        eq(schema.events.published, true),
        eq(schema.venues.published, true),
        gte(schema.events.createdAt, since),
        sql`COALESCE(${schema.events.imageUrl}, ${schema.venues.imageUrl}) IS NOT NULL`,
      ),
    )
    .orderBy(desc(schema.events.createdAt))
    .limit(6);
  if (rows.length < 6) {
    throw new Error(`minder dan 6 nieuwe events deze week (${rows.length})`);
  }

  const occRows = await db
    .select({
      eventId: schema.occurrences.eventId,
      startsAt: schema.occurrences.startsAt,
      endsAt: schema.occurrences.endsAt,
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
  const firstOccByEvent = new Map<
    string,
    { startsAt: Date; endsAt: Date | null }
  >();
  for (const o of occRows) {
    if (!firstOccByEvent.has(o.eventId)) {
      firstOccByEvent.set(o.eventId, { startsAt: o.startsAt, endsAt: o.endsAt });
    }
  }

  const picks = rows.map((r) => {
    const occ = firstOccByEvent.get(r.id);
    const startsAt = occ?.startsAt ?? r.createdAt;
    return {
      eventId: r.id,
      imageUrl: r.imageUrl ?? r.venueImageUrl ?? '',
      title: r.title,
      venueName: r.venueName,
      venueType: r.venueType,
      category: r.category,
      startsAt,
      endsAt: occ?.endsAt ?? null,
      daysAgo: Math.max(
        0,
        Math.floor(
          (now.getTime() - r.createdAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      ),
    };
  });

  const baseUnits: HookUnit[] = [
    { role: 'eyebrow', text: 'JUST IN' },
    { role: 'countLead', text: 'NIEUW' },
    { role: 'count', text: String(picks.length) },
    { role: 'headline', text: 'shows aangekondigd' },
    { role: 'meta', text: 'Amsterdam\n{date}' },
  ];
  const dateRange = formatWindowRange(1, now);
  const hookUnits = withDynamicDate(
    withDynamicCount(baseUnits, picks.length),
    dateRange,
  );

  return {
    hookUnits,
    overviewTitle: `Top ${picks.length} net aangekondigd`,
    dateLabel: dateRange,
    picks,
  };
}
