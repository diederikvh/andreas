import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Amsterdam Alternative services-API — gedeelde JSON-backend voor een
 * groep Amsterdamse onafhankelijke venues (Plein Theater, OCCII, OT301,
 * Splendor, Filmhuis Cavia, Cinetol, Studio/K, Roode Bioscoop, Vondel-
 * bunker, Framer Framed, Kriterion, De Uitkijk, Plantage Dok, ...).
 *
 *   GET https://amsterdamalternative.nl/services/get-events-past-v25.php
 *       ?image=true&venue={id}&month={1-12}&months={N}&past=false
 *
 * Response:
 *   { items: [{ id, start (unix), title, lineup, price, presale (URL),
 *               type: {id,label}, header: {id, kind, file},
 *               venue, venue_room, past, started }, ...] }
 *
 * Eén HTTP-call per venue geeft de complete programmering — geen detail-
 * page fetches nodig. Image-CDN: `amsterdamalternative.nl/media/content/
 * {headerId}.{ext}` (kind='image') of een YouTube/Vimeo embed (kind=
 * 'player'). Voor kind=player slaan we image-mirror over.
 *
 * Idempotency:
 *   eventId      = `evt-aa-{venueId}-{titleSlug}`
 *   occurrenceId = `occ-aa-{venueId}-{aaId}` (aaId is uniek per occurrence)
 *
 * Multi-night shows komen als losse items met dezelfde titel; we groeperen
 * op title-slug naar één event met N occurrences.
 */

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const API_BASE = 'https://amsterdamalternative.nl/services/get-events-past-v25.php';
const MEDIA_BASE = 'https://amsterdamalternative.nl/media/content';

type AaItem = {
  id: number;
  start: number;
  title: string;
  lineup?: string | null;
  price?: string | null;
  presale?: string | null;
  type?: { id: number; label: string };
  header?: { id: number; kind: string; file: string };
  venue?: string;
  venue_room?: string | false | null;
  past?: boolean;
};

async function fetchItems(venueId: number): Promise<AaItem[]> {
  // 1-indexed month, 12 maanden vooruit. AA's API limiteert intern op
  // 25 rows; voor de meeste onafhankelijke venues is dat ruim genoeg.
  // Mocht een venue groeien voorbij 25 toekomstige events: per-maand
  // loopen. Voor nu één call.
  const now = new Date();
  const month = now.getMonth() + 1;
  const u = `${API_BASE}?image=true&venue=${venueId}&month=${month}&months=12&past=false`;
  try {
    const r = await fetch(u, {
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        referer: 'https://amsterdamalternative.nl/',
      },
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { items?: AaItem[] };
    return d.items ?? [];
  } catch {
    return [];
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c) => String.fromCodePoint(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&euml;/g, 'ë').replace(/&euro;/g, '€')
    .replace(/&egrave;/g, 'è').replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú').replace(/&aacute;/g, 'á')
    .replace(/&iuml;/g, 'ï').replace(/&ouml;/g, 'ö')
    .replace(/&auml;/g, 'ä').replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘').replace(/&hellip;/g, '…');
}

/** Fetch venue's eigen detail-pagina (bv. plein-theater.nl/agenda/{id})
 *  en pluk `item.text` uit het App()-init JSON blok. De AA-services
 *  list-API geeft alleen titel + lineup, de detail-pagina heeft de
 *  echte description. */
async function fetchDetailDescription(siteUrl: string, eventId: number): Promise<string | null> {
  try {
    const url = `${siteUrl.replace(/\/$/, '')}/agenda/${eventId}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    // `"text":"<h2>...<\/p>"` — JSON-encoded string. Match alleen het
    // text-veld (niet greedy) en JSON.parse hem als string-literal.
    const m = html.match(/"text":"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    let rawHtml: string;
    try {
      rawHtml = JSON.parse('"' + m[1] + '"');
    } catch {
      return null;
    }
    const text = decodeEntities(stripTags(rawHtml));
    return text.slice(0, 800) || null;
  } catch {
    return null;
  }
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
    return await uploadToBunny(`media/events/aa-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[aaservices] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

type Category = 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';

/** Map AA's `type.label` naar Andreas eventCategory. Onbekend → null
 *  (fallback naar venue.categories[0]). */
function mapCategory(label: string | undefined): Category | null {
  if (!label) return null;
  switch (label.toLowerCase()) {
    case 'theatre':
    case 'dance performance':
    case 'kids':
      return 'Theater';
    case 'concert':
    case 'electronic music, party':
      return 'Muziek';
    case 'film':
      return 'Film';
    case 'talk':
      // Lezing-gate: 'Lezing' mapt back naar 'Literatuur' tot nieuwe
      // native build live is. Zie TODO(lezing-gate) markers.
      return 'Literatuur';
    case 'poetry, reading, literature':
      return 'Literatuur';
    case 'exhibition, art':
      return 'Kunst';
    default:
      return null;
  }
}

function parsePriceCents(price: string | null | undefined): number | null {
  if (!price) return null;
  // "10", "12,50 (vanaf)", "10,- (vanaf)", "0", "50,- inclusief diner"
  const m = price.match(/(\d+)(?:[,.](\d{1,2}))?/);
  if (!m) return null;
  const euros = parseInt(m[1], 10);
  const cents = m[2] ? parseInt(m[2].padEnd(2, '0').slice(0, 2), 10) : 0;
  return euros * 100 + cents;
}

export type AaServicesResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeAaServices(options?: {
  venueIds?: string[];
}): Promise<AaServicesResult[]> {
  const allVenues = await db.select().from(schema.venues);
  const targets = allVenues.filter((v) => {
    if (options?.venueIds && !options.venueIds.includes(v.id)) return false;
    return Boolean(v.scraperConfig?.aaservices?.venueId);
  });

  const results: AaServicesResult[] = [];

  for (const venue of targets) {
    const cfg = venue.scraperConfig!.aaservices!;
    const result: AaServicesResult = {
      venueId: venue.id, fetched: 0, inserted: 0,
      occurrencesUpserted: 0, skipped: 0, errors: [],
    };
    const venueCategory = venue.categories?.[0] ?? 'Theater';

    const items = await fetchItems(cfg.venueId);
    result.fetched = items.length;
    if (items.length === 0) {
      result.errors.push(`geen items voor venue ${cfg.venueId}`);
      results.push(result);
      continue;
    }

    // Group items by title-slug — multi-night shows verschijnen als losse
    // items met dezelfde titel.
    const groups = new Map<string, AaItem[]>();
    for (const it of items) {
      const key = slugify(it.title);
      if (!key) continue;
      const arr = groups.get(key) ?? [];
      arr.push(it);
      groups.set(key, arr);
    }

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;

    for (const [titleSlug, group] of groups) {
      try {
        const head = group[0];
        const fresh = group.filter((it) => it.start * 1000 > cutoff);
        if (fresh.length === 0) {
          result.skipped++;
          continue;
        }

        const eventId = `evt-aa-${venue.id}-${titleSlug}`;
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;
        const mappedCategory = mapCategory(head.type?.label) ?? venueCategory;

        if (!existing) {
          let imageUrl: string | null = null;
          if (head.header?.kind === 'image' && head.header.file) {
            // AA serveert images alleen onder `{id}_small.jpg` en
            // `{id}_large.jpg`, ongeacht de extensie die de API
            // teruggeeft (`21045.png` bestaat niet — server geeft
            // dan een HTML-redirect). Pak altijd `{id}_large.jpg`.
            const headerId = head.header.file.replace(/\.[^.]+$/, '');
            const src = `${MEDIA_BASE}/${headerId}_large.jpg`;
            imageUrl = (await mirrorImage(src, `${venue.id}-${titleSlug}`)) ?? src;
          }

          // AA-list-API heeft geen description; als venue's eigen site
          // geconfigureerd is, pluk 'm uit de detail-pagina. Fallback:
          // lineup-string. enrich krijgt zo de richtste tekst-hint.
          let detailDescription: string | null = null;
          if (cfg.siteUrl) {
            detailDescription = await fetchDetailDescription(cfg.siteUrl, head.id);
          }
          const enrichDescription = detailDescription
            ?? (head.lineup ? `Line-up: ${head.lineup}` : null);

          try {
            enriched = await enrichEvent({
              title: head.title,
              description: enrichDescription,
              venueName: venue.name,
              venueCategory: mappedCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${head.title}: ${(e as Error).message}`);
          }

          const headStart = new Date(fresh[0].start * 1000);
          const eventKind = refineKindByDuration(
            enriched?.kind ?? 'show',
            headStart,
            null,
          );

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: head.title,
              description: enriched?.cleanedDescription ?? enrichDescription,
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

        for (const it of fresh) {
          try {
            const occurrenceId = `occ-aa-${venue.id}-${it.id}`;
            const startsAt = new Date(it.start * 1000);
            const priceCents = parsePriceCents(it.price);
            const ticketUrl = it.presale && it.presale.length > 0
              ? it.presale
              : null;
            // AA's `lineup` is een platte string ("Huba de Graaff, Nora
            // Mulder"); ons lineup-veld is structured `{ name, role }[]`.
            // We laten enrich (LLM) de structurering doen — de raw tekst
            // hebben we al via description meegegeven. Bij update enkel
            // tijd/url/prijs refreshen.
            const lineup = existing ? null : (enriched?.lineup ?? null);

            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt,
                endsAt: null,
                priceCents,
                priceNote: existing ? null : (enriched?.priceNote ?? it.price ?? null),
                ticketUrl,
                room: typeof it.venue_room === 'string' ? it.venue_room : null,
                lineup,
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                set: { startsAt, priceCents, ticketUrl },
              });
            result.occurrencesUpserted++;
          } catch (e) {
            result.errors.push(`occurrence ${it.id}: ${(e as Error).message}`);
            result.skipped++;
          }
        }
      } catch (e) {
        result.errors.push(`group ${titleSlug}: ${(e as Error).message}`);
        result.skipped++;
      }
    }
    results.push(result);
  }

  return results;
}
