import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import {
  ANDREAS_UA,
  decode,
  fetchHtml,
  shiftToLocalTime,
} from './_museum-helpers.js';

/**
 * Amsterdam Museum (amsterdammuseum.nl) scraper.
 *
 * /zien-en-doen/agenda is een Craft-CMS Next.js-listing. De render-page
 * embed een data-blob met alle tentoonstellingen als JSON-stringified
 * entries: `"title":"…","url":"https://…/tentoonstelling/SLUG/ID",
 * "subtitle":"…","eventType":"temporary","startDate":"YYYY-MM-DD HH:MM",
 * "endDate":"YYYY-MM-DD HH:MM",…"image":[{"url":"…"}]`.
 *
 * Permanente installaties hebben `eventType: 'permanent'` en geen
 * concrete dates — die worden automatisch geskipt door de regex (die
 * alleen entries pakt waar zowel startDate als endDate ingevuld zijn).
 *
 * Kind = 'exhibition' (startsAt 11:00, endsAt 18:00 op einddatum).
 */

const VENUE_ID = 'amsterdam-museum';
const LISTING_URL = 'https://www.amsterdammuseum.nl/zien-en-doen/agenda';

type CardRaw = {
  url: string;
  slug: string;
  title: string;
  subtitle: string | null;
  startsAt: Date;
  endsAt: Date;
  imageUrl: string | null;
};

function extractCards(html: string): CardRaw[] {
  const out: CardRaw[] = [];
  const seen = new Set<string>();

  // Combined regex: title → url → subtitle (optional) → startDate →
  // endDate → image-url (eerste gevonden). Met `[\s\S]{0,2000}?` als
  // lazy gap om binnen één entity te blijven.
  const re =
    /"title":"([^"]+)","[^"]*":"[^"]*","url":"(https:\/\/www\.amsterdammuseum\.nl\/tentoonstelling\/([a-z0-9-]+)\/(\d+))"(?:[\s\S]{0,400}?"subtitle":"([^"]*)")?[\s\S]{0,400}?"startDate":"(\d{4}-\d{2}-\d{2})[^"]*","endDate":"(\d{4}-\d{2}-\d{2})[^"]*"[\s\S]{0,2000}?"image":\[\{[^}]*?"url":"([^"]+)"/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const title = decode(m[1]);
    const url = m[2];
    const slug = m[3];
    const id = m[4];
    const subtitle = m[5] ? decode(m[5]) : null;
    const startStr = m[6];
    const endStr = m[7];
    const imageUrl = decode(m[8]);

    const composite = `${slug}-${id}`;
    if (seen.has(composite)) continue;
    seen.add(composite);

    const [sy, sm, sd] = startStr.split('-').map(Number);
    const [ey, em, ed] = endStr.split('-').map(Number);
    if (!sy || !ey) continue;

    const startsAt = shiftToLocalTime(sy, sm - 1, sd, 11, 0);
    const endsAt = shiftToLocalTime(ey, em - 1, ed, 18, 0);

    out.push({
      url,
      slug: composite,
      title,
      subtitle,
      startsAt,
      endsAt,
      imageUrl,
    });
  }
  return out;
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': ANDREAS_UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('webp')
        ? 'webp'
        : 'jpg';
    return await uploadToBunny(
      `media/events/amsterdammuseum-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(
      `[amsterdammuseum] mirror image failed: ${(e as Error).message}`
    );
    return null;
  }
}

export type AmsterdamMuseumResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeAmsterdamMuseum(options?: {
  venueIds?: string[];
}): Promise<AmsterdamMuseumResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: AmsterdamMuseumResult = {
    venueId: VENUE_ID,
    fetched: 0,
    inserted: 0,
    occurrencesUpserted: 0,
    skipped: 0,
    errors: [],
  };

  const [venue] = await db
    .select()
    .from(schema.venues)
    .where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }

  const html = await fetchHtml(LISTING_URL);
  if (!html) {
    result.errors.push('listing niet bereikbaar');
    return [result];
  }

  const all = extractCards(html);
  const now = Date.now();
  const cards = all.filter(
    (c) => c.endsAt.getTime() >= now - 24 * 60 * 60_000
  );
  result.fetched = cards.length;

  const venueCategory = venue.categories?.[0] ?? 'Kunst';

  for (const card of cards) {
    try {
      const eventId = `evt-amsterdammuseum-${card.slug}`;
      const occurrenceId = `occ-amsterdammuseum-${card.slug}`;

      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (existing) {
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: null,
            ticketUrl: card.url,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              endsAt: card.endsAt,
              ticketUrl: card.url,
            },
          });
        result.occurrencesUpserted++;
        continue;
      }

      const enriched = await enrichEvent({
        title: card.title,
        description: card.subtitle,
        venueName: venue.name,
        venueCategory,
      });

      let imageUrl: string | null = null;
      if (card.imageUrl) {
        imageUrl = (await mirrorImage(card.imageUrl, card.slug)) ?? card.imageUrl;
      }

      const refinedKind = refineKindByDuration(
        'exhibition',
        card.startsAt,
        card.endsAt
      );

      await db.transaction(async (tx) => {
        await tx.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: card.title,
          description: enriched.cleanedDescription ?? card.subtitle,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;

        await tx
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: card.startsAt,
            endsAt: card.endsAt,
            priceCents: null,
            priceNote: enriched.priceNote,
            ticketUrl: card.url,
            room: enriched.room,
            lineup: enriched.lineup,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: {
              startsAt: card.startsAt,
              endsAt: card.endsAt,
              priceNote: enriched.priceNote,
              ticketUrl: card.url,
              room: enriched.room,
              lineup: enriched.lineup,
            },
          });
        result.occurrencesUpserted++;
      });
    } catch (e) {
      result.errors.push(`${card.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
