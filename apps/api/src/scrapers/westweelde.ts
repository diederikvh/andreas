import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * West Weelde (Westerpark) — SvelteKit-frontend, Sanity-CMS backend.
 * Project `qcf0k7mi`, dataset `production`, document-type `events`.
 *
 *   GET https://qcf0k7mi.api.sanity.io/v2021-06-07/data/query/production
 *       ?query=*[_type=="events"&&date>="YYYY-MM-DD"]{...}
 *
 * Velden die we gebruiken:
 *   _id, title (localeString nl/en), date (YYYY-MM-DD),
 *   time (string "20:00 - 04:00" of null),
 *   slug.current, category (Clubnight, LATIN, ADE, Food event, …),
 *   image.asset._ref ("image-{hash}-{WxH}-{ext}"),
 *   url (ticket-/info-URL), description (Portable Text localeBlockContent)
 *
 * Image-CDN: `cdn.sanity.io/images/{project}/{dataset}/{hash}-{WxH}.{ext}`
 *
 * Idempotency: `evt-ww-{slug}`, `occ-ww-{slug}`.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const SANITY_PROJECT = 'qcf0k7mi';
const SANITY_DATASET = 'production';
const SANITY_BASE = `https://${SANITY_PROJECT}.api.sanity.io/v2021-06-07/data/query/${SANITY_DATASET}`;
const IMG_BASE = `https://cdn.sanity.io/images/${SANITY_PROJECT}/${SANITY_DATASET}`;
const VENUE_ID = 'west-weelde';

type LocaleString = { _type: 'localeString'; nl?: string; en?: string };

type SanityBlock = {
  _type: 'block';
  children?: Array<{ _type: 'span'; text?: string }>;
};

type LocaleBlockContent = {
  _type: 'localeBlockContent';
  nl?: SanityBlock[];
  en?: SanityBlock[];
};

type SanityEvent = {
  _id: string;
  title: LocaleString;
  date: string;
  time: string | null;
  // GROQ-projection `"slug":slug.current` levert een string, niet een
  // `{current: ...}` object.
  slug?: string | null;
  category?: string | null;
  imageRef?: string | null;
  url?: string | null;
  description?: LocaleBlockContent | null;
};

function pickLocale(s: LocaleString | undefined): string | null {
  if (!s) return null;
  return s.nl?.trim() || s.en?.trim() || null;
}

function blocksToText(blocks: SanityBlock[] | undefined): string {
  if (!blocks) return '';
  const out: string[] = [];
  for (const b of blocks) {
    if (b._type !== 'block' || !b.children) continue;
    const line = b.children.map((c) => c.text ?? '').join('');
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n\n');
}

function pickDescription(d: LocaleBlockContent | undefined | null): string | null {
  if (!d) return null;
  const nl = blocksToText(d.nl);
  if (nl) return nl.slice(0, 800);
  const en = blocksToText(d.en);
  return en ? en.slice(0, 800) : null;
}

/** Sanity image-_ref: `image-{hash}-{WxH}-{ext}` → CDN URL. */
function imageRefToUrl(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = ref.match(/^image-([a-f0-9]+)-(\d+x\d+)-([a-z0-9]+)$/);
  if (!m) return null;
  return `${IMG_BASE}/${m[1]}-${m[2]}.${m[3]}`;
}

/** Parse `time` veld ("20:00 - 04:00", "12:00-17:00") naar start/end uur. */
function parseTimeRange(time: string | null | undefined): {
  startHour: number; startMin: number;
  endHour: number | null; endMin: number;
} | null {
  if (!time) return null;
  const m = time.match(/(\d{1,2})[:.](\d{2})\s*[-–]\s*(\d{1,2})[:.](\d{2})/);
  if (m) {
    return {
      startHour: parseInt(m[1], 10), startMin: parseInt(m[2], 10),
      endHour: parseInt(m[3], 10), endMin: parseInt(m[4], 10),
    };
  }
  // Alleen start-tijd: "20:00"
  const s = time.match(/(\d{1,2})[:.](\d{2})/);
  if (s) {
    return {
      startHour: parseInt(s[1], 10), startMin: parseInt(s[2], 10),
      endHour: null, endMin: 0,
    };
  }
  return null;
}

/**
 * West Weelde laat `time` regelmatig leeg op een event en zet de
 * canonieke tijd in de beschrijving (bv "⏰ TIJDEN: 18:00 - 02:00"
 * of "deuren open 19:00"). Zonder dit valt de scraper terug op
 * `defaultStartHour` (22:00 voor clubnights) en staan Latin Nights
 * 4u te laat in de app. Eerste plausibele tijd-pattern wint.
 */
function extractTimeFromDescription(
  desc: LocaleBlockContent | null | undefined,
): string | null {
  if (!desc) return null;
  const text = `${blocksToText(desc.nl)}\n${blocksToText(desc.en)}`;
  if (!text) return null;
  // Voorkeur: expliciete "TIJDEN ... HH:MM - HH:MM"-regel.
  const tijdRegex = /(?:tijden?|aanvang|deuren|doors)[^\n]{0,40}?(\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2})/i;
  const tijdMatch = text.match(tijdRegex);
  if (tijdMatch) return tijdMatch[1];
  // Anders: eerste HH:MM - HH:MM range (vaak de Area-1 hoofdtijd).
  const range = text.match(/\b(\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2})\b/);
  if (range) return range[1];
  return null;
}

/** Default starttijd op basis van category als `time` ontbreekt. Most
 *  events bij West Weelde zijn club/dance (~22:00). Food/cocktails =
 *  middag. Voetbal kijken = ~20:00. */
function defaultStartHour(category: string | null | undefined): number {
  const c = (category ?? '').toLowerCase();
  if (c.includes('food') || c.includes('cocktail') || c.includes('brunch')) return 12;
  if (c.includes('voetbal') || c.includes('sport')) return 20;
  if (c.includes('festival')) return 14;
  return 22;
}

/** Bouw start-Date in Amsterdam-tz (DST-aware via offset op datum). */
function buildAmsDate(dateStr: string, hour: number, minute: number): Date {
  // dateStr = "YYYY-MM-DD". Bepaal DST grof: mar-oct = +02, anders +01.
  const m = parseInt(dateStr.slice(5, 7), 10);
  const dst = m >= 3 && m <= 10;
  const off = dst ? '+02:00' : '+01:00';
  return new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${off}`);
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 16 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png'
      : mime.includes('webp') ? 'webp'
      : mime.includes('avif') ? 'avif' : 'jpg';
    return await uploadToBunny(`media/events/ww-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[westweelde] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

function mapCategory(cat: string | null | undefined): Category {
  const c = (cat ?? '').toLowerCase();
  // Voetbal op grootscherm = filmvertoning-vibes (publiek kijkt
  // collectief naar groot scherm), niet muziek.
  if (c.includes('voetbal') || c.includes('sport') || c.includes('film')) {
    return 'Film';
  }
  // Food/Cocktails/Brunch/Oesterdag passen niet in onze 6 cats.
  // Theater = "belevenis" — dinnershow, tasting, etc.
  if (c.includes('food') || c.includes('cocktail')
    || c.includes('brunch') || c.includes('oester')
    || c.includes('parel')) {
    return 'Theater';
  }
  // Alle club/dance varianten (Clubnight, LATIN, ADE, Afterparty,
  // LGBTQIA+, Festival) → Muziek.
  return 'Muziek';
}

async function fetchEvents(): Promise<SanityEvent[]> {
  // Today onwards. Groq-projection vraagt alleen wat we nodig hebben.
  const today = new Date().toISOString().slice(0, 10);
  const groq = `*[_type=="events"&&date>="${today}"]{`
    + '_id,title,date,time,'
    + '"slug":slug.current,'
    + 'category,'
    + '"imageRef":image.asset._ref,'
    + 'url,description'
    + '}|order(date asc)';
  const u = `${SANITY_BASE}?query=${encodeURIComponent(groq)}`;
  try {
    const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' } });
    if (!r.ok) return [];
    const d = (await r.json()) as { result?: SanityEvent[] };
    return d.result ?? [];
  } catch {
    return [];
  }
}

export type WestWeeldeResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeWestWeelde(_options?: {
  venueIds?: string[];
}): Promise<WestWeeldeResult[]> {
  const result: WestWeeldeResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0,
    occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID))
    .limit(1);
  if (!venue) {
    result.errors.push(`venue ${VENUE_ID} bestaat niet`);
    return [result];
  }

  const items = await fetchEvents();
  result.fetched = items.length;

  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const ev of items) {
    try {
      const slug = ev.slug;
      if (!slug || !ev.date) {
        result.skipped++;
        continue;
      }
      const title = pickLocale(ev.title);
      if (!title) {
        result.skipped++;
        continue;
      }

      const effectiveTime = ev.time || extractTimeFromDescription(ev.description);
      const tr = parseTimeRange(effectiveTime);
      const startHour = tr?.startHour ?? defaultStartHour(ev.category);
      const startMin = tr?.startMin ?? 0;
      const startsAt = buildAmsDate(ev.date, startHour, startMin);
      if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < cutoff) {
        result.skipped++;
        continue;
      }

      let endsAt: Date | null = null;
      if (tr && tr.endHour !== null) {
        const isOvernight = tr.endHour < tr.startHour
          || (tr.endHour === tr.startHour && tr.endMin < tr.startMin);
        const endDateStr = isOvernight
          ? new Date(new Date(`${ev.date}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000)
              .toISOString().slice(0, 10)
          : ev.date;
        endsAt = buildAmsDate(endDateStr, tr.endHour, tr.endMin);
      }

      const eventId = `evt-ww-${slug}`;
      const occurrenceId = `occ-ww-${slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      const mappedCategory = mapCategory(ev.category);
      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        let imageUrl: string | null = null;
        const sourceImg = imageRefToUrl(ev.imageRef);
        if (sourceImg) {
          imageUrl = (await mirrorImage(sourceImg, slug)) ?? sourceImg;
        }
        const description = pickDescription(ev.description);

        try {
          enriched = await enrichEvent({
            title,
            description,
            venueName: venue.name,
            venueCategory: mappedCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(
          enriched?.kind ?? 'show', startsAt, endsAt,
        );

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: VENUE_ID,
            title,
            description: enriched?.cleanedDescription ?? description,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? mappedCategory,
            featured: false,
            genres: enriched?.genres ?? [],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
      }

      // Bestaande events: hercorrigeer `kind` als de huidige
      // start/end tot een andere classificatie leiden. Zonder dit
      // blijven events die per ongeluk eerder als 'exhibition'
      // werden weggezet (door foutieve 00:00/24h-duurtijden) hangen,
      // wat de Hele-dag-normalisatie in `events.ts` triggert en de
      // app de echte tijd verbergt.
      if (existing) {
        const corrected = refineKindByDuration('show', startsAt, endsAt);
        try {
          await db
            .update(schema.events)
            .set({ kind: corrected })
            .where(eq(schema.events.id, eventId));
        } catch (e) {
          result.errors.push(`update kind ${eventId}: ${(e as Error).message}`);
        }
      }

      try {
        const ticketUrl = ev.url
          || `https://www.westweelde.nl/events/${slug}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt, endsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
      } catch (e) {
        result.errors.push(`occurrence ${slug}: ${(e as Error).message}`);
        result.skipped++;
      }
    } catch (e) {
      result.errors.push(`event ${ev._id}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
