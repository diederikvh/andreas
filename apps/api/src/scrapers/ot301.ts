import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * OT301 (artist-run venue, voormalig kraakpand). Hun /nl/agenda is
 * een SPA waar events client-side worden gerenderd. Structuur:
 *
 *   div.agenda
 *     div.head: "Zaterdag 09 Mei"  ← day-header (Dutch, geen jaar)
 *     a.event-item: "Koop tickets|Café Gilde // 17:00 // € 12|Dinner at Café Gilde|..."
 *     a.event-item: ...
 *     div.head: "Dinsdag 12 Mei"
 *     ...
 *
 * Elke a.event-item heeft als textContent een geconcat string van:
 *  - "Koop tickets" (optioneel CTA prefix)
 *  - "{Ruimte} // {Tijd} // {Prijs}" (subtitle in eigen <span>)
 *  - "{Title}" (title in eigen <span>)
 *  - "{Lineup}" (optioneel)
 *
 * We parsen via inner spans/elements ipv de text-blob.
 *
 * Title-grouping (geleerd): "Lunch at Café Gilde" komt elke dag terug
 * — dat wordt 1 event met N occurrences (eventId = slugify(title)).
 */

const VENUE_ID = 'ot301';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const AGENDA_URL = 'https://www.ot301.nl/nl/agenda';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, feb: 2, maa: 3, mar: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

type RawTile = {
  href: string;
  subtitle: string;   // "Café Gilde // 17:00 // € 12"
  title: string;      // "Dinner at Café Gilde"
  lineup: string;     // rest of the text
  date: string;       // "Zaterdag 09 Mei"
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * "Zaterdag 09 Mei" + tijd "17:00" → Date in juiste jaar (probeer
 * current-year, dan next-year als datum >180 dagen achter ons valt).
 */
function parseDutchDateTime(dayHeader: string, time: string): Date | null {
  const m = dayHeader.toLowerCase().match(/\b(\d{1,2})\s+(\w{3,})\b/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthName = m[2].slice(0, 3);
  const month = DUTCH_MONTHS_SHORT[monthName];
  if (!month) return null;
  const t = time.match(/(\d{1,2}):(\d{2})/);
  const hh = t ? parseInt(t[1], 10) : 20;
  const mm = t ? parseInt(t[2], 10) : 0;

  const now = new Date();
  for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+02:00`);
    if (isNaN(d.getTime())) continue;
    // Accept als binnen 1 jaar van nu
    const delta = d.getTime() - now.getTime();
    if (delta > -7 * 24 * 60 * 60 * 1000 && delta < 365 * 24 * 60 * 60 * 1000) return d;
  }
  return null;
}

async function fetchTiles(): Promise<RawTile[]> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(AGENDA_URL, { waitUntil: 'networkidle', timeout: 30000 });
    const tiles = (await page.evaluate(`(() => {
      const container = document.querySelector('.agenda');
      if (!container) return [];
      const out = [];
      let currentDay = '';
      const children = Array.from(container.children);
      for (const node of children) {
        if (node.classList && node.classList.contains('head')) {
          currentDay = (node.textContent || '').trim();
          continue;
        }
        if (node.tagName === 'A' && node.classList.contains('event-item')) {
          const link = node;
          const href = link.href || '';
          // Parse inner spans
          const spans = Array.from(link.querySelectorAll('span, div, p'));
          const texts = spans
            .map(s => (s.textContent || '').replace(/\\s+/g, ' ').trim())
            .filter(t => t && !/^Koop tickets$/i.test(t));
          // First text = subtitle "Café Gilde // 17:00 // € 12"
          // Second = title
          // Rest = lineup
          let subtitle = '';
          let title = '';
          let lineup = '';
          // Find first text that contains "//"
          const subIdx = texts.findIndex(t => t.includes('//'));
          if (subIdx >= 0) {
            subtitle = texts[subIdx];
            title = texts[subIdx + 1] || '';
            lineup = texts.slice(subIdx + 2).join(' / ').slice(0, 400);
          } else {
            // Fallback: split textContent by br-equivalents
            const all = (link.textContent || '').replace(/Koop tickets/i, '').replace(/\\s+/g, ' ').trim();
            title = all.slice(0, 80);
          }
          out.push({ href, subtitle, title, lineup, date: currentDay });
        }
      }
      return out;
    })()`)) as RawTile[];
    return tiles;
  } finally {
    await browser.close();
  }
}

/**
 * OT301 detail-page parser. URL is `https://www.ot301.nl/nl/agenda/{id}`.
 * Geen og-meta of JSON-LD, maar wel een `<div class="selected event">`
 * met body-content, en de image staat als `amsterdamalternative.nl/
 * media/content/{id}_large.jpg`.
 */
async function fetchDetailMeta(href: string): Promise<{ image: string | null; description: string | null }> {
  try {
    const r = await fetch(href, { headers: { 'user-agent': UA } });
    if (!r.ok) return { image: null, description: null };
    const html = await r.text();
    // Pak de eerste amsterdamalternative-image (= event-foto, meestal `_large.jpg`)
    const imgMatch = html.match(
      /(https?:\/\/(?:www\.)?amsterdamalternative\.nl\/media\/content\/[^"'\s>]+\.(?:jpg|jpeg|png|webp))/i
    );
    const image = imgMatch?.[1] ?? null;
    // Body content: alles binnen `<div class="info">` is event-text
    // (subtitle, title, lineup, beschrijving). Strip HTML.
    const bodyMatch = html.match(/<div[^>]+class="[^"]*\binfo\b[^"]*"[^>]*>([\s\S]+?)<\/div>\s*<\/div>/);
    let description: string | null = null;
    if (bodyMatch) {
      const text = bodyMatch[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Strip de subtitle-prefix "Café Gilde // 13:00 // € 0" + "Koop tickets" /
      // "buy now" zodat alleen de echte beschrijving overblijft.
      const cleaned = text
        .replace(/^.*?(?:Koop tickets|buy now)\s*/i, '')
        .replace(/^[A-Z][^/]+\/\/\s*\d{1,2}:\d{2}\s*\/\/\s*[^A-Z]+/i, '')
        .trim();
      description = cleaned.length > 30 ? cleaned : (text.length > 30 ? text : null);
    }
    return { image, description };
  } catch { return { image: null, description: null }; }
}

async function mirrorImage(sourceUrl: string, slug: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/ot-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[ot301] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type Ot301Result = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  skipped: number;
  errors: string[];
};

export async function scrapeOt301(options?: { venueIds?: string[] }): Promise<Ot301Result[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: Ot301Result = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0, skipped: 0, errors: [],
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Muziek';

  let tiles: RawTile[];
  try {
    tiles = await fetchTiles();
  } catch (e) {
    result.errors.push(`fetch tiles: ${(e as Error).message}`);
    return [result];
  }
  result.fetched = tiles.length;
  if (tiles.length === 0) {
    result.errors.push('geen tiles ontdekt');
    return [result];
  }

  // Parse subtitle naar room + time: "Café Gilde // 17:00 // € 12"
  type Slot = {
    titleSlug: string;
    title: string;
    room: string;
    time: string;
    startsAt: Date;
    href: string;
    lineup: string;
    priceNote: string | null;
  };
  const slots: Slot[] = [];
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;

  for (const t of tiles) {
    if (!t.title || t.title.length < 3) continue;
    // "Café Gilde // 17:00 // € 12"
    const parts = t.subtitle.split(/\s*\/\/\s*/);
    const room = parts[0]?.trim() ?? '';
    const time = parts[1]?.trim() ?? '';
    const priceNote = parts[2]?.trim() || null;
    const startsAt = parseDutchDateTime(t.date, time);
    if (!startsAt || startsAt.getTime() < cutoff) continue;
    const titleSlug = slugify(t.title);
    if (!titleSlug) continue;
    slots.push({
      titleSlug, title: t.title, room, time, startsAt, href: t.href, lineup: t.lineup, priceNote,
    });
  }

  if (slots.length === 0) {
    result.errors.push('geen toekomstige slots na parse');
    return [result];
  }

  // Group on titleSlug — multi-day events met zelfde naam (Lunch at
  // Café Gilde elke dag) worden 1 event met N occurrences.
  type Group = { titleSlug: string; head: Slot; slots: Slot[] };
  const groups = new Map<string, Group>();
  for (const s of slots) {
    const g = groups.get(s.titleSlug);
    if (g) g.slots.push(s);
    else groups.set(s.titleSlug, { titleSlug: s.titleSlug, head: s, slots: [s] });
  }
  // Sort each group's slots
  for (const g of groups.values()) {
    g.slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    g.head = g.slots[0];
  }

  for (const group of groups.values()) {
    try {
      const eventId = `evt-ot-${group.titleSlug}`;
      const [existing] = await db
        .select({ id: schema.events.id })
        .from(schema.events)
        .where(eq(schema.events.id, eventId))
        .limit(1);

      let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

      if (!existing) {
        // Detail-page voor og-meta (image, description)
        const detail = await fetchDetailMeta(group.head.href);
        let imageUrl: string | null = null;
        if (detail.image) {
          imageUrl = (await mirrorImage(detail.image, group.titleSlug)) ?? detail.image;
        }
        // Description = og:description + lineup-info als context
        const baseDesc = detail.description ?? null;
        const lineup = group.head.lineup;

        try {
          enriched = await enrichEvent({
            title: group.head.title,
            description: baseDesc,
            venueName: venue.name,
            venueCategory,
          });
        } catch (e) {
          result.errors.push(`enrich ${group.head.title}: ${(e as Error).message}`);
        }

        const eventKind = refineKindByDuration(enriched?.kind ?? 'show', group.head.startsAt, null);

        try {
          await db.insert(schema.events).values({
            id: eventId,
            venueId: venue.id,
            title: group.head.title,
            description: enriched?.cleanedDescription ?? baseDesc,
            kind: eventKind,
            imageUrl,
            category: enriched?.category ?? venueCategory,
            featured: false,
            genres: enriched?.genres ?? [],
            published: true,
          });
          result.inserted++;
        } catch (e) {
          result.errors.push(`insert event ${eventId}: ${(e as Error).message}`);
          continue;
        }
        // Lineup is in OT301 een vrije text (lijst van DJ-namen, of
        // info over de avond). Schema verwacht structured `{name,role}[]`,
        // dus we negeren het als lineup-veld en laten enrichEvent zelf
        // beoordelen of er namen in te halen zijn.
        void lineup;
      }

      for (const s of group.slots) {
        try {
          const isoSlot = `${s.startsAt.toISOString().slice(0, 10)}T${s.time.replace(':', '-')}`;
          const occurrenceId = `occ-ot-${group.titleSlug}-${isoSlot}`;
          await db
            .insert(schema.occurrences)
            .values({
              id: occurrenceId,
              eventId,
              startsAt: s.startsAt,
              endsAt: null,
              priceCents: null,
              priceNote: s.priceNote,
              ticketUrl: s.href,
              room: s.room || null,
              lineup: existing ? null : (enriched?.lineup ?? null),
              status: 'scheduled',
            })
            .onConflictDoUpdate({
              target: schema.occurrences.id,
              set: {
                startsAt: s.startsAt,
                priceNote: s.priceNote,
                ticketUrl: s.href,
                room: s.room || null,
              },
            });
          result.occurrencesUpserted++;
        } catch (e) {
          result.errors.push(`occurrence ${s.startsAt.toISOString()}: ${(e as Error).message}`);
          result.skipped++;
        }
      }
    } catch (e) {
      result.errors.push(`group ${group.titleSlug}: ${(e as Error).message}`);
      result.skipped++;
    }
  }

  return [result];
}
