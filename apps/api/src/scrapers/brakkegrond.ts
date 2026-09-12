import { and, eq, gt, inArray } from 'drizzle-orm';
import { chromium, type Browser } from 'playwright';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { parseTicketSlots, type Slot } from './_brakkegrond-dates.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';

/**
 * Vlaams Cultuurhuis De Brakke Grond. Hun /agenda is volledig CSR en
 * detail-pages óók — geen JSON-LD, geen og-meta met betekenisvolle
 * description, geen sitemap die helpt.
 *
 * Strategie:
 *  1. Playwright opent `/agenda`, harvest show-URLs `/agenda/{id}/{slug}`
 *  2. Per show-page (Playwright, `domcontentloaded` want `networkidle`
 *     timeout't door long-poll websockets):
 *       - h1 → title
 *       - .text-block.block (NL) → description
 *       - figure.gallery-block__image img → image
 *       - .event-detail__tickets-{date,info} → speeldata en tijd
 *
 * De datums komen uit de ticketkolom, niet uit de lopende tekst. Dat
 * was hier jarenlang mis: de oude parser zocht in de body naar
 * "vr 18 sep, 18:30 — 23:59", en dat formaat staat op precies één van
 * de 41 pagina's. De andere 40 werden stil overgeslagen — gemeten op
 * 2026-09-11, drie scrape-runs op rij hetzelfde. Vandaar ook
 * `skipReasons` in het resultaat: een overslag zonder reden is
 * onzichtbaar, en onzichtbaar betekende hier: maanden.
 *
 * Title-grouping: één event-row per show, N occurrences per speeldag
 * (multi-night theater is regel hier).
 *
 * Idempotency:
 *  - eventId      = `evt-bg-{showId}` (numeriek deel uit URL)
 *  - occurrenceId = `occ-bg-{showId}-{YYYY-MM-DD}T{HH-MM}` (UTC)
 */

const VENUE_ID = 'de-brakke-grond';
const UA = 'Mozilla/5.0 (Andreas/1.0)';
const AGENDA_URL = 'https://brakkegrond.nl/agenda';

type ShowMeta = {
  url: string;
  showId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  room: string | null;
  slots: Slot[];
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

type AgendaCard = { url: string; category: string };

/**
 * De agendakaart draagt het type in een eigen element
 * (`.card-default__category`, of `.event-highlights__categories` op de
 * uitgelichte kaart): "Voorstelling", "Expositie", "Festival | Te gast",
 * "Residentie". Op de detailpagina staat dat nergens, dus het moet hier
 * mee — en daardoor hoeven residenties niet eens opgehaald te worden.
 */
async function harvestShowUrls(browser: Browser): Promise<AgendaCard[]> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(AGENDA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    // Trigger render door scroll
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i + 1) / 4})`);
      await page.waitForTimeout(500);
    }
    const cards = (await page.evaluate(`(() => {
      var clean = function (el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
      var re = /\\/agenda\\/(\\d+)\\/[a-z][a-z0-9-]+$/;
      var links = document.querySelectorAll('a[href*="/agenda/"]');
      var seen = {};
      var out = [];
      for (var i = 0; i < links.length; i++) {
        var a = links[i];
        var href = a.href || '';
        if (!re.test(href) || seen[href]) continue;
        seen[href] = 1;
        var card = a.closest('li,article,div');
        var cat = card ? card.querySelector('.card-default__category, .event-highlights__categories') : null;
        out.push({ url: href, category: clean(cat) });
      }
      return out;
    })()`)) as AgendaCard[];
    return cards;
  } finally {
    await ctx.close();
  }
}

async function fetchShowMeta(browser: Browser, url: string): Promise<ShowMeta | null> {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    // Scroll naar onder voor lazy content
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitForTimeout(800);

    const data = (await page.evaluate(`(() => {
      var clean = function (el) { return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; };
      var title = clean(document.querySelector('h1'));
      // Image: fullscreen--trigger data-src is hi-res; img src is thumb
      var fs = document.querySelector('.fullscreen--trigger[data-src]');
      var galleryImg = document.querySelector('.gallery-block__item-image');
      var image = (fs && fs.getAttribute('data-src')) || (galleryImg && galleryImg.src) || '';
      // Description (NL eerst): meerdere .text-block kunnen voorkomen,
      // pak de eerste die niet alleen credits/whitespace heeft.
      var blocks = document.querySelectorAll('.text-block.block, .text-block, .event-detail__english-description');
      var description = '';
      for (var i = 0; i < blocks.length; i++) {
        var t = clean(blocks[i]);
        if (t.length > 80) { description = t; break; }
      }
      // Speeldata en tijd staan in de ticketkolom, in twee aparte divs.
      var info = document.querySelector('.event-detail__tickets-info');
      var infoParts = [];
      if (info) {
        var kids = info.querySelectorAll('div');
        for (var j = 0; j < kids.length; j++) {
          var k = clean(kids[j]);
          if (k) infoParts.push(k);
        }
      }
      return {
        title: title,
        image: image,
        description: description,
        dateText: clean(document.querySelector('.event-detail__tickets-date')),
        infoText: clean(info),
        infoParts: infoParts
      };
    })()`)) as {
      title: string; image: string; description: string;
      dateText: string; infoText: string; infoParts: string[];
    };

    if (!data.title) return null;
    const idMatch = url.match(/\/agenda\/(\d+)\//);
    const showId = idMatch?.[1] ?? slugify(data.title);
    const slots = parseTicketSlots(data.dateText, data.infoText);
    if (slots.length === 0) return null;

    // Zaal: het infoblok bevat naast de zaal ook losse mededelingen
    // ("Gratis toegang. Graag even aanmelden.", "Meer info volgt
    // binnenkort!"). Een zaalnaam is een kort label zonder zinstekens —
    // "Grote zaal", "Rode zaal", of bij een uitvoering elders
    // "Theater Bellevue". "de Brakke Grond" is de venue zelf en zegt
    // niets over waar je moet zijn.
    const room = data.infoParts.find(
      (x) =>
        !/[.!?]/.test(x) &&
        x.split(/\s+/).length <= 4 &&
        !/\d{1,2}[:.]\d{2}/.test(x) &&
        !/brakke\s*grond/i.test(x)
    ) ?? null;

    return {
      url,
      showId,
      title: data.title,
      description: data.description.length > 30 ? data.description : null,
      imageUrl: data.image && !data.image.startsWith('data:') ? data.image : null,
      room,
      slots,
    };
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
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
    return await uploadToBunny(`media/events/bg-${slug}.${ext}`, buf, mime);
  } catch (e) {
    console.warn(`[brakkegrond] mirror image failed: ${(e as Error).message}`);
    return null;
  }
}

export type BrakkeGrondResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  /** Waaróm er is overgeslagen. Een kale teller verbergt een kapotte
      parser: die stond hier 40 van de 41 pagina's over te slaan en het
      log zei alleen `skipped: 40`. */
  skipReasons: Record<string, number>;
  errors: string[];
};

export async function scrapeBrakkeGrond(options?: {
  venueIds?: string[];
}): Promise<BrakkeGrondResult[]> {
  if (options?.venueIds && !options.venueIds.includes(VENUE_ID)) return [];

  const result: BrakkeGrondResult = {
    venueId: VENUE_ID, fetched: 0, inserted: 0, occurrencesUpserted: 0,
    occurrencesPruned: 0, skipped: 0, skipReasons: {}, errors: [],
  };
  const skip = (reden: string) => {
    result.skipped++;
    result.skipReasons[reden] = (result.skipReasons[reden] ?? 0) + 1;
  };

  const [venue] = await db.select().from(schema.venues).where(eq(schema.venues.id, VENUE_ID));
  if (!venue) {
    result.errors.push('venue niet in DB');
    return [result];
  }
  const venueCategory = venue.categories?.[0] ?? 'Theater';

  const browser = await chromium.launch();
  try {
    const cards = await harvestShowUrls(browser);
    result.fetched = cards.length;
    if (cards.length === 0) {
      result.errors.push('geen show-URLs op /agenda');
      return [result];
    }

    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    /** eventId → occurrence-ids die de bron dit rondje aanbood. */
    const seenOcc = new Map<string, Set<string>>();

    for (const { url, category } of cards) {
      try {
        // Een residentie is een werkperiode, geen voorstelling: geen
        // tijd, geen kaartverkoop, niks om heen te gaan. De Brakke Grond
        // zet ze wel op de agenda, wij niet.
        //
        // De ticketknop leek eerst het signaal, maar dat is 'ie niet:
        // zeventien pagina's missen die knop en daar zitten gewone
        // festivals bij (IDFA DocLab, Brainwash) die hun kaarten elders
        // verkopen. Het categorie-label is wél eenduidig.
        if (/residentie/i.test(category)) {
          skip('residentie');
          // Leeg in seenOcc zetten zodat de prune eerder ingelezen
          // datums opruimt. Het event-rijtje blijft leeg achter; dat
          // ruimt scripts/_prune-orphan-events.ts op.
          const resId = url.match(/\/agenda\/(\d+)\//)?.[1];
          if (resId) seenOcc.set(`evt-bg-${resId}`, new Set());
          continue;
        }
        const meta = await fetchShowMeta(browser, url);
        if (!meta) { skip('geen titel of geen datum in ticketblok'); continue; }

        const futureSlots = meta.slots.filter((s) => (s.endsAt ?? s.startsAt).getTime() > cutoff);
        if (futureSlots.length === 0) { skip('alle speeldata voorbij'); continue; }

        const eventId = `evt-bg-${meta.showId}`;
        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          let imageUrl: string | null = null;
          if (meta.imageUrl) {
            imageUrl = (await mirrorImage(meta.imageUrl, meta.showId)) ?? meta.imageUrl;
          }
          try {
            enriched = await enrichEvent({
              title: meta.title,
              description: meta.description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${meta.title}: ${(e as Error).message}`);
          }

          const headStart = futureSlots[0]!.startsAt;
          const headEnd = futureSlots[0]!.endsAt;
          const eventKind = refineKindByDuration(enriched?.kind ?? 'show', headStart, headEnd);

          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title: meta.title,
              description: enriched?.cleanedDescription ?? meta.description,
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
        }

        for (const slot of futureSlots) {
          try {
            const isoDate = slot.startsAt.toISOString().slice(0, 10);
            const isoTime = slot.startsAt.toISOString().slice(11, 16).replace(':', '-');
            const occurrenceId = `occ-bg-${meta.showId}-${isoDate}T${isoTime}`;
            await db
              .insert(schema.occurrences)
              .values({
                id: occurrenceId,
                eventId,
                startsAt: slot.startsAt,
                endsAt: slot.endsAt,
                priceCents: null,
                priceNote: existing ? null : (enriched?.priceNote ?? null),
                ticketUrl: meta.url,
                room: meta.room,
                lineup: existing ? null : (enriched?.lineup ?? null),
                status: 'scheduled',
              })
              .onConflictDoUpdate({
                target: schema.occurrences.id,
                // room hoort hierbij: die komt elke ronde vers uit de
                // bron, dus een correctie moet een bestaande rij ook
                // bereiken. priceNote en lineup blijven insert-only —
                // die worden door enrich gezet, niet door de bron.
                set: {
                  startsAt: slot.startsAt,
                  endsAt: slot.endsAt,
                  ticketUrl: meta.url,
                  room: meta.room,
                },
              });
            result.occurrencesUpserted++;
            const seen = seenOcc.get(eventId) ?? new Set<string>();
            seen.add(occurrenceId);
            seenOcc.set(eventId, seen);
          } catch (err) {
            result.errors.push(`occurrence ${meta.url} ${slot.startsAt.toISOString()}: ${(err as Error).message}`);
            skip('occurrence-write faalde');
          }
        }
      } catch (e) {
        result.errors.push(`show ${url}: ${(e as Error).message}`);
        skip('exception op detailpagina');
      }
    }

    // Toekomstige datums weghalen die de bron niet meer aanbiedt.
    // Zonder dit blijven oude rijen eeuwig staan: er stonden hier 35
    // toekomstige occurrences uit 14 juni die door niemand meer
    // bevestigd werden, en bij een datumwijziging zag je dat nooit.
    //
    // Alleen voor events die we dit rondje écht gezien hebben — een
    // pagina die timeout't of tijdelijk geen ticketblok heeft raakt
    // seenOcc nooit en blijft dus onaangeraakt.
    const pruneCutoff = new Date(cutoff);
    for (const [eventId, keep] of seenOcc) {
      try {
        const bestaand = await db
          .select({ id: schema.occurrences.id })
          .from(schema.occurrences)
          .where(
            and(
              eq(schema.occurrences.eventId, eventId),
              gt(schema.occurrences.startsAt, pruneCutoff)
            )
          );
        const drop = bestaand.map((r) => r.id).filter((id) => !keep.has(id));
        if (!drop.length) continue;
        // Saves hangen aan occurrence-ids. Liever een verlopen rij dan
        // een verdwenen save.
        const saved = await db
          .select({ occurrenceId: schema.saves.occurrenceId })
          .from(schema.saves)
          .where(inArray(schema.saves.occurrenceId, drop));
        const savedIds = new Set(saved.map((r) => r.occurrenceId));
        const finalDrop = drop.filter((id) => !savedIds.has(id));
        if (!finalDrop.length) continue;
        await db
          .delete(schema.occurrences)
          .where(inArray(schema.occurrences.id, finalDrop));
        result.occurrencesPruned += finalDrop.length;
      } catch (e) {
        result.errors.push(`prune ${eventId}: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  return [result];
}
