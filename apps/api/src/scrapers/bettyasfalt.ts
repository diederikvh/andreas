import { eq } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Betty Asfalt Complex (theater op de Nieuwezijds Voorburgwal) scraper.
 *
 * `/agenda.php` is een platte XHTML-lijst met één `.agendarow` per
 * voorstellings-datum. Pakketstructuur per row:
 *   - .agendadag    weekdag-naam ("zondag")
 *   - .agendadatum  DD-MM-YYYY
 *   - .agendaproductie  twee divs: titel + subtitel-rij, beide met
 *     `<a href="voorstelling.php?id=NNNN">`
 *   - .agendatijd   "HH:MM uur"
 *
 * Maand-headers (`<h1>juni 2026</h1>`) staan ook in `.agendadag`-divs
 * binnen rows zonder de andere velden — die filteren we eruit.
 *
 * De Betty-ID per row is per voorstelling-datum uniek (elke avond
 * krijgt z'n eigen `id=NNNN`), terwijl dezelfde productie tientallen
 * keren wordt geprogrammeerd. We groeperen daarom op titel: één
 * event-rij per productie met N occurrences eronder. Voor de eerste
 * occurrence van een productie fetchen we de detail-pagina voor
 * description + image; latere occurrences slaan dat over.
 */

const VENUE_ID = 'betty-asfalt';
const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';
const BASE = 'https://www.bettyasfaltcomplex.nl';
const AGENDA_URL = `${BASE}/agenda.php`;

type RawOccurrence = {
  date: string; // DD-MM-YYYY
  time: string; // HH:MM
  title: string;
  subtitle: string | null;
  voorstellingId: number; // unieke ID per occurrence in Betty's CMS
};

type Production = {
  title: string;
  subtitle: string | null;
  slug: string;
  occurrences: { startsAt: Date; voorstellingId: number }[];
  firstVoorstellingId: number;
};

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function shiftToLocalTime(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number
): Date {
  const tentative = new Date(Date.UTC(y, mo, d, h, mi, 0));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const off = dtf
    .formatToParts(tentative)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = off?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m && m[1] === '+' ? 1 : -1;
  const oh = m ? parseInt(m[2], 10) : 0;
  const om = m ? parseInt(m[3] ?? '0', 10) : 0;
  return new Date(tentative.getTime() - sign * (oh * 60 + om) * 60_000);
}

function extractRows(html: string): RawOccurrence[] {
  const rows: RawOccurrence[] = [];
  // Split op `agendarow`. Eerste segment is alles vóór de eerste row.
  const segments = html.split(/<div class="agendarow">/);
  for (const block of segments.slice(1)) {
    // Skip maand-header rows (bevatten geen datum-veld).
    const dateMatch = block.match(
      /<div class="agendadatum">(\d{2}-\d{2}-\d{4})<\/div>/
    );
    if (!dateMatch) continue;

    const timeMatch = block.match(
      /<div class="agendatijd">(\d{1,2}):(\d{2})\s*uur<\/div>/
    );
    if (!timeMatch) continue;

    // Twee `.agendaproductie` divs, beide met een link naar dezelfde
    // voorstelling.php?id=...
    const prods = Array.from(
      block.matchAll(
        /<div class="agendaproductie">[\s\S]*?<a href="voorstelling\.php\?id=(\d+)">([\s\S]*?)<\/a>/g
      )
    );
    if (prods.length === 0) continue;
    const voorstellingId = parseInt(prods[0][1], 10);
    const title = decode(stripTags(prods[0][2]));
    if (!title) continue;
    const subtitle =
      prods.length > 1 ? decode(stripTags(prods[1][2])) || null : null;

    rows.push({
      date: dateMatch[1],
      time: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
      title,
      subtitle,
      voorstellingId,
    });
  }
  return rows;
}

function groupByProduction(rows: RawOccurrence[]): Production[] {
  const map = new Map<string, Production>();
  for (const r of rows) {
    // Group-key: titel + subtitel zodat varianten met dezelfde titel
    // maar andere uitvoerders niet samenvallen.
    const key = `${r.title}|${r.subtitle ?? ''}`;
    const [dd, mm, yyyy] = r.date.split('-').map((n) => parseInt(n, 10));
    const [hh, mi] = r.time.split(':').map((n) => parseInt(n, 10));
    const startsAt = shiftToLocalTime(yyyy, mm - 1, dd, hh, mi);
    const existing = map.get(key);
    if (existing) {
      existing.occurrences.push({ startsAt, voorstellingId: r.voorstellingId });
    } else {
      map.set(key, {
        title: r.title,
        subtitle: r.subtitle,
        slug: slugify(r.title),
        occurrences: [{ startsAt, voorstellingId: r.voorstellingId }],
        firstVoorstellingId: r.voorstellingId,
      });
    }
  }
  return Array.from(map.values()).map((p) => ({
    ...p,
    occurrences: p.occurrences.sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime()
    ),
  }));
}

type DetailInfo = {
  description: string | null;
  imageUrl: string | null;
};

function extractDetail(html: string): DetailInfo {
  // Description komt uit `<div class="kolomc">`, gestript van tags.
  let description: string | null = null;
  const descMatch = html.match(/<div class="kolomc">([\s\S]*?)<\/div>/);
  if (descMatch) {
    const body = decode(stripTags(descMatch[1]));
    if (body.length > 40) description = body.slice(0, 2000);
  }

  // Image: eerste `<img src="fotos/...">` in de content. Relatief
  // pad → maken we absoluut.
  let imageUrl: string | null = null;
  const imgMatch = html.match(/<img\s+src="(fotos\/[^"]+)"/);
  if (imgMatch) imageUrl = `${BASE}/${imgMatch[1]}`;

  return { description, imageUrl };
}

async function mirrorImage(
  sourceUrl: string,
  slug: string
): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
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
      `media/events/bettyasfalt-${slug}.${ext}`,
      buf,
      mime
    );
  } catch (e) {
    console.warn(`[bettyasfalt] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BettyAsfaltResult = {
  venueId: string;
  fetched: number;
  productions: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeBettyAsfalt(options?: {
  venueIds?: string[];
}): Promise<BettyAsfaltResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BettyAsfaltResult = {
    venueId: VENUE_ID,
    fetched: 0,
    productions: 0,
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

  const html = await fetchHtml(AGENDA_URL);
  if (!html) {
    result.errors.push('/agenda.php niet bereikbaar');
    return [result];
  }

  const rows = extractRows(html);
  result.fetched = rows.length;

  const productions = groupByProduction(rows);
  result.productions = productions.length;

  const venueCategory = venue.categories?.[0] ?? 'Theater';

  for (const prod of productions) {
    try {
      const eventId = `evt-bettyasfalt-${prod.slug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      if (!existing) {
        // Nieuwe productie — fetch detail-pagina voor description + image.
        const detailUrl = `${BASE}/voorstelling.php?id=${prod.firstVoorstellingId}`;
        const detailHtml = await fetchHtml(detailUrl);
        const detail = detailHtml
          ? extractDetail(detailHtml)
          : ({ description: null, imageUrl: null } satisfies DetailInfo);

        const enriched = await enrichEvent({
          title: prod.title,
          description: detail.description ?? prod.subtitle,
          venueName: venue.name,
          venueCategory,
        });

        let imageUrl: string | null = null;
        if (detail.imageUrl) {
          imageUrl =
            (await mirrorImage(detail.imageUrl, prod.slug)) ?? detail.imageUrl;
        }

        const firstStart = prod.occurrences[0]!.startsAt;
        const refinedKind = refineKindByDuration('show', firstStart, null);

        await db.insert(schema.events).values({
          id: eventId,
          venueId: venue.id,
          title: prod.title,
          description: enriched.cleanedDescription ?? detail.description ?? prod.subtitle,
          kind: refinedKind,
          imageUrl,
          category: enriched.category ?? venueCategory,
          featured: false,
          genres: enriched.genres,
          published: true,
        });
        result.inserted++;
      }

      // Per occurrence — gebruik de Betty-voorstelling-id als suffix
      // (uniek + idempotent over runs).
      for (const occ of prod.occurrences) {
        const occurrenceId = `occ-bettyasfalt-${occ.voorstellingId}`;
        const ticketUrl = `${BASE}/voorstelling.php?id=${occ.voorstellingId}`;
        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            startsAt: occ.startsAt,
            endsAt: null,
            priceCents: null,
            priceNote: null,
            ticketUrl,
            room: null,
            lineup: null,
            status: 'scheduled',
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { startsAt: occ.startsAt, ticketUrl },
          });
        result.occurrencesUpserted++;
      }
    } catch (e) {
      result.errors.push(`${prod.slug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
