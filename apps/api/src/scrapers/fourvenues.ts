import { and, eq, gt, inArray } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { uploadToBunny } from '../storage/bunny.js';
import { enrichEvent, refineKindByDuration } from './enrich.js';
import { loadVenueTitleMap, resolveEventId } from './_title-dedup.js';

/**
 * Fourvenues — via hun eigen JSON-API in plaats van de iframe-widget.
 *
 * De oude opzet las `<app-event-card>`-elementen uit de Angular-widget met
 * Playwright. Fourvenues heeft die widget verbouwd naar een kalender: de
 * cards bestaan niet meer, dus de scraper leverde 0 events terwijl Madam
 * gewoon programmeerde. Onder de widget zit een schone API:
 *
 *   GET /generateGuestToken            → { data: { token } }   (geen auth)
 *   GET /api/events?startDate=<unix>&endDate=<unix>&slug=<slug>
 *       &groupCodes[0]=<group>&pageSize=200&page=1
 *       Authorization: Bearer <token>  → { data: [ … ] }
 *
 * Let op de slug-vorm in onze config: `madam@g:pwsbn` is géén slug maar
 * `slug=madam` + `groupCodes[0]=pwsbn`. De oude iframe-URL slikte de
 * combinatie; deze API wil ze gesplitst.
 *
 * Per event geeft de API name, description, image, genres (echte array,
 * dus die hoeft Claude niet te raden) en `dates`:
 * `{date, start, end, canceled}` in unix-seconden.
 *
 * Geen browser meer nodig — deze scraper kan dus in de dagelijkse CI.
 *
 * Idempotency: `evt-fv-{venueId}-{code}` / `occ-fv-{venueId}-{code}`.
 * `code` is Fourvenues' eigen korte event-id en is stabiel. De oude ids
 * waren `{MM-DD}-{titel-slug}` — zonder jaar, dus een jaarlijkse
 * herhaling botste.
 */

const API_BASE = 'https://cli-api-service.fourvenues.com';
const IFRAME_BASE = 'https://site.fourvenues.com/en/iframe';
const MONTHS_AHEAD = 5;
const FETCH_TIMEOUT_MS = 20_000;

export type FourvenuesResult = {
  venueId: string;
  fetched: number;
  inserted: number;
  occurrencesUpserted: number;
  occurrencesPruned: number;
  skipped: number;
  errors: string[];
};

type ApiEvent = {
  id?: string;
  code?: string;
  slug?: string;
  name?: string;
  description?: string | null;
  image?: string | null;
  genres?: string[] | null;
  dates?: { date?: number; start?: number; end?: number; canceled?: unknown } | null;
};

async function guestToken(): Promise<string | null> {
  try {
    const r = await fetch(`${API_BASE}/generateGuestToken`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { token?: string } };
    return j.data?.token ?? null;
  } catch {
    return null;
  }
}

async function mirrorImage(sourceUrl: string, stableId: string): Promise<string | null> {
  try {
    const r = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return null;
    const mime = r.headers.get('content-type') ?? 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    return await uploadToBunny(`media/events/fv-${stableId}.${ext}`, buf, mime);
  } catch {
    return null;
  }
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export async function scrapeFourvenues(options?: {
  venueIds?: string[];
}): Promise<FourvenuesResult[]> {
  const all = await db.select().from(schema.venues);
  const targets = all.filter((v) => {
    const cfg = (v.scraperConfig as { fourvenues?: { slug?: string } } | null)?.fourvenues;
    if (!cfg?.slug) return false;
    return !options?.venueIds || options.venueIds.includes(v.id);
  });

  const results: FourvenuesResult[] = [];
  const token = await guestToken();

  for (const venue of targets) {
    const result: FourvenuesResult = {
      venueId: venue.id,
      fetched: 0,
      inserted: 0,
      occurrencesUpserted: 0,
      occurrencesPruned: 0,
      skipped: 0,
      errors: [],
    };
    results.push(result);

    if (!token) {
      result.errors.push('geen guest-token van de API');
      continue;
    }

    const raw = (venue.scraperConfig as { fourvenues: { slug: string } }).fourvenues.slug;
    // `madam@g:pwsbn` → slug=madam, groupCodes[0]=pwsbn
    const [slug, group] = raw.includes('@g:') ? raw.split('@g:') : [raw, null];

    const now = Math.floor(Date.now() / 1000);
    const qs = new URLSearchParams({
      startDate: String(now - 6 * 3600),
      endDate: String(now + MONTHS_AHEAD * 31 * 86400),
      slug,
      pageSize: '200',
      page: '1',
    });
    if (group) qs.set('groupCodes[0]', group);

    let events: ApiEvent[] = [];
    try {
      const r = await fetch(`${API_BASE}/api/events?${qs}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) {
        // 404 betekent hier: deze slug bestaat niet (meer) bij Fourvenues.
        result.errors.push(`api HTTP ${r.status} voor slug ${slug}`);
        continue;
      }
      const j = (await r.json()) as { data?: ApiEvent[] };
      events = j.data ?? [];
    } catch (e) {
      result.errors.push(`api: ${(e as Error).message}`);
      continue;
    }
    result.fetched = events.length;
    console.log(`[fourvenues] ${venue.id}: ${events.length} events via de API (slug=${slug})`);

    const byTitle = await loadVenueTitleMap(venue.id, `evt-fv-${venue.id}-`);
    const venueCategory = venue.categories?.[0] ?? 'Muziek';
    const seenOcc = new Set<string>();

    for (const ev of events) {
      try {
        const code = ev.code;
        const title = ev.name?.trim();
        const startSec = ev.dates?.start ?? ev.dates?.date;
        if (!code || !title || !startSec) {
          result.skipped++;
          continue;
        }
        const startsAt = new Date(startSec * 1000);
        const endsAt = ev.dates?.end ? new Date(ev.dates.end * 1000) : null;
        if (isNaN(startsAt.getTime())) {
          result.skipped++;
          continue;
        }
        const description = ev.description ? stripTags(ev.description).slice(0, 2000) || null : null;
        const ticketUrl = `${IFRAME_BASE}/${encodeURIComponent(raw)}/events/${code}`;
        const status: 'scheduled' | 'cancelled' = ev.dates?.canceled ? 'cancelled' : 'scheduled';

        const { eventId } = resolveEventId(byTitle, title, `evt-fv-${venue.id}-${code}`, {
          startsAt,
          description,
        });
        const occurrenceId = `occ-fv-${venue.id}-${code}`;

        const [existing] = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.id, eventId))
          .limit(1);

        let enriched: Awaited<ReturnType<typeof enrichEvent>> | null = null;

        if (!existing) {
          let imageUrl: string | null = null;
          if (ev.image) imageUrl = (await mirrorImage(ev.image, code)) ?? ev.image;
          try {
            enriched = await enrichEvent({
              title,
              description,
              venueName: venue.name,
              venueCategory,
            });
          } catch (e) {
            result.errors.push(`enrich ${title}: ${(e as Error).message}`);
          }
          // De API geeft echte genres — die gaan voor op wat Claude gokt.
          const genres = ev.genres?.length ? ev.genres : (enriched?.genres ?? []);
          try {
            await db.insert(schema.events).values({
              id: eventId,
              venueId: venue.id,
              title,
              description: enriched?.cleanedDescription ?? description,
              kind: refineKindByDuration(enriched?.kind ?? 'show', startsAt, endsAt),
              imageUrl,
              category: enriched?.category ?? venueCategory,
              featured: false,
              genres,
              published: true,
            });
            result.inserted++;
          } catch (e) {
            result.errors.push(`insert ${eventId}: ${(e as Error).message}`);
            continue;
          }
        }

        await db
          .insert(schema.occurrences)
          .values({
            id: occurrenceId,
            eventId,
            venueId: venue.id,
            startsAt,
            endsAt,
            priceCents: null,
            priceNote: existing ? null : (enriched?.priceNote ?? null),
            ticketUrl,
            room: null,
            lineup: existing ? null : (enriched?.lineup ?? null),
            status,
          })
          .onConflictDoUpdate({
            target: schema.occurrences.id,
            set: { eventId, venueId: venue.id, startsAt, endsAt, ticketUrl, status },
          });
        result.occurrencesUpserted++;
        seenOcc.add(occurrenceId);
      } catch (e) {
        result.errors.push(`event ${ev.code ?? '?'}: ${(e as Error).message}`);
        result.skipped++;
      }
    }

    // Sweep: de API geeft het complete programma voor dit venster, dus een
    // toekomstige occurrence die we deze run niet schreven is verlopen —
    // inclusief de restanten van de oude `{MM-DD}-{titel}`-ids. Alleen als
    // er iets binnenkwam, en occurrences met een save blijven staan.
    if (seenOcc.size) {
      try {
        const cutoff = new Date(Date.now() - 6 * 3600_000);
        const ourEvents = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(eq(schema.events.venueId, venue.id));
        const rows = ourEvents.length
          ? await db
              .select({ id: schema.occurrences.id })
              .from(schema.occurrences)
              .where(
                and(
                  inArray(schema.occurrences.eventId, ourEvents.map((e) => e.id)),
                  gt(schema.occurrences.startsAt, cutoff)
                )
              )
          : [];
        const orphaned = rows.map((r) => r.id).filter((id) => !seenOcc.has(id));
        if (orphaned.length) {
          const saved = await db
            .select({ occurrenceId: schema.saves.occurrenceId })
            .from(schema.saves)
            .where(inArray(schema.saves.occurrenceId, orphaned));
          const savedIds = new Set(saved.map((s) => s.occurrenceId));
          const drop = orphaned.filter((id) => !savedIds.has(id));
          if (drop.length) {
            await db.delete(schema.occurrences).where(inArray(schema.occurrences.id, drop));
            result.occurrencesPruned += drop.length;
          }
        }
      } catch (e) {
        result.errors.push(`sweep: ${(e as Error).message}`);
      }
    }

    console.log(
      `[fourvenues] ${venue.id} done — fetched=${result.fetched} inserted=${result.inserted} ` +
        `occ=${result.occurrencesUpserted} pruned=${result.occurrencesPruned} ` +
        `skipped=${result.skipped} errors=${result.errors.length}`
    );
  }

  return results;
}
