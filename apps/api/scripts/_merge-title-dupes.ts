/**
 * Voeg events samen die binnen één venue dezelfde genormaliseerde titel
 * hebben: één event, alle datums als occurrences.
 *
 * Een gelijke titel alleen is NIET genoeg. `description` zit op
 * event-niveau, dus samenvoegen platslaat de tekst van avond 2..N.
 * Gemeten: van 90 clusters met meer dan één description hebben 81 écht
 * andere tekst (tot 1% overeenkomst) — "CinemAnita Fiber Factory" is
 * elke week een andere film. Daar is de gelijke titel een serienaam,
 * geen identiteit.
 *
 * Dus dezelfde regel als resolveEventId in _title-dedup.ts — samenvoegen
 * mag als één van twee dingen klopt:
 *
 *   datum sluit aan (≤1 dag)  — alias-URL op dezelfde dag (Frascati's
 *     typo-correctie, Meervaart's twee URLs) of een run over
 *     opeenvolgende avonden ("Fat Freddy's Drop" 12/13/14 okt).
 *   description komt overeen  — terugkerende avond die echt elke keer
 *     hetzelfde is ("Dynasty | 21+"). Datums liggen weken uit elkaar,
 *     dus alleen de tekst kan het bevestigen.
 *
 * Occurrences worden VERPLAATST, niet verwijderd: saves hangen aan
 * occurrence-ids, dus verplaatsen houdt ze heel. Alleen een occurrence
 * die exact samenvalt met één op het blijvende event is echt dubbel en
 * gaat weg — en dan nog alleen als er geen save aan hangt.
 *
 * Dry-run tenzij --apply. Beperk met --venue=<id>[,<id>…].
 *
 * ponytail: prefix-vergelijking i.p.v. edit-distance, en één map-entry
 * per titel. Teksten die hetzelfde zijn zijn byte-identiek tot een
 * eventuele slotzin, dus dat is genoeg; bij echt fuzzy bronnen is dit
 * het punt om aan te scherpen.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { descriptionSimilarity, SAME_SHOW_SIMILARITY, titleKey } from '../src/scrapers/_title-dedup.js';

const APPLY = process.argv.includes('--apply');
/** Komma-lijst: `--venue=frascati,meervaart`. Nodig omdat de merge
    alleen duurzaam is voor scrapers die insert-time al op titel
    dedupliceren (nu: theater.ts). Voor venues waar de bron per avond
    een eigen id geeft (celebratix, odessa, melkweg, patronaat) voegt
    de volgende scrape de rijen gewoon opnieuw toe. */
const VENUES = process.argv.find((a) => a.startsWith('--venue='))?.split('=')[1]?.split(',').filter(Boolean);

const evs = await db
  .select({
    id: schema.events.id, venueId: schema.events.venueId, title: schema.events.title,
    description: schema.events.description, imageUrl: schema.events.imageUrl,
    genres: schema.events.genres,
  })
  .from(schema.events)
  .where(VENUES?.length ? inArray(schema.events.venueId, VENUES) : sql`true`)
  .orderBy(asc(schema.events.id));

const groups = new Map<string, typeof evs>();
for (const e of evs) {
  const k = `${e.venueId}|${titleKey(e.title)}`;
  groups.set(k, [...(groups.get(k) ?? []), e] as typeof evs);
}

let mergedEvents = 0, movedOcc = 0, droppedOcc = 0, keptForSave = 0;

for (const [key, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (members.length < 2) continue;
  const keeper = members[0];               // laagste id — deterministisch
  const candidates = members.slice(1);

  const loserOcc = await db
    .select({ id: schema.occurrences.id, eventId: schema.occurrences.eventId, startsAt: schema.occurrences.startsAt })
    .from(schema.occurrences)
    .where(inArray(schema.occurrences.eventId, candidates.map((e) => e.id)))
    .orderBy(asc(schema.occurrences.startsAt));
  const keeperOcc = await db
    .select({ id: schema.occurrences.id, startsAt: schema.occurrences.startsAt })
    .from(schema.occurrences)
    .where(eq(schema.occurrences.eventId, keeper.id));

  // Zelfde regel als resolveEventId in _title-dedup.ts: een gelijke
  // titel is niet genoeg. Alleen samenvoegen als de datum aansluit
  // (alias-URL of run) óf de description overeenkomt (terugkerende
  // avond die echt elke keer hetzelfde is). Anders blijft het een eigen
  // event — "CinemAnita Fiber Factory" is elke week een andere film en
  // zou z'n tekst verliezen.
  const keeperDays = keeperOcc.map((o) => o.startsAt.getTime());
  const keeperDesc = (keeper.description ?? '').trim();
  const losers: typeof candidates = [];
  const skipped: string[] = [];
  for (const c of candidates) {
    const cDays = loserOcc.filter((o) => o.eventId === c.id).map((o) => o.startsAt.getTime());
    const adjacent = cDays.some((t) =>
      keeperDays.some((k) => Math.abs(k - t) <= 86_400_000)
    );
    const cDesc = (c.description ?? '').trim();
    const descOk = !cDesc || !keeperDesc
      || descriptionSimilarity(cDesc, keeperDesc) > SAME_SHOW_SIMILARITY;
    if (adjacent || descOk) losers.push(c);
    else skipped.push(c.id);
  }
  if (!losers.length) {
    if (skipped.length) {
      console.log(`SKIP  ${key} — ${skipped.length} event(s) met eigen description, laat staan`);
    }
    continue;
  }

  const taken = new Set(keeperOcc.map((o) => o.startsAt.getTime()));
  const toMove: string[] = [];
  const toDrop: string[] = [];
  const loserIdSet = new Set(losers.map((e) => e.id));
  for (const o of loserOcc.filter((o) => loserIdSet.has(o.eventId))) {
    if (taken.has(o.startsAt.getTime())) {
      const saves = await db.select().from(schema.saves)
        .where(eq(schema.saves.occurrenceId, o.id));
      if (saves.length) { toMove.push(o.id); keptForSave++; }   // save > netheid
      else toDrop.push(o.id);
    } else {
      taken.add(o.startsAt.getTime());
      toMove.push(o.id);
    }
  }

  // Velden bijvullen op de keeper vanuit de losers.
  const patch: { description?: string; imageUrl?: string; genres?: string[] } = {};
  if (!keeper.description) {
    const d = losers.find((e) => e.description)?.description;
    if (d) patch.description = d;
  }
  if (!keeper.imageUrl) {
    const i = losers.find((e) => e.imageUrl)?.imageUrl;
    if (i) patch.imageUrl = i;
  }
  if (!keeper.genres?.length) {
    const g = losers.find((e) => e.genres?.length)?.genres;
    if (g?.length) patch.genres = g;
  }

  const days = [...taken].sort().map((t) => new Date(t).toISOString().slice(0, 10));
  console.log(`${APPLY ? 'MERGE' : 'DRY  '} ${key}  (${members.length} events → 1, ${days.length} datums)`);
  console.log(`        keep   ${keeper.id}`);
  if (Object.keys(patch).length) console.log(`        event  += ${Object.keys(patch).join(', ')}`);
  console.log(`        occ    verplaats ${toMove.length}, verwijder ${toDrop.length}`);
  for (const l of losers) console.log(`        weg    ${l.id}`);
  for (const sk of skipped) console.log(`        blijft ${sk}  (eigen description)`);

  if (APPLY) {
    await db.transaction(async (tx) => {
      if (Object.keys(patch).length) {
        await tx.update(schema.events).set(patch).where(eq(schema.events.id, keeper.id));
      }
      if (toMove.length) {
        await tx.update(schema.occurrences)
          .set({ eventId: keeper.id, venueId: keeper.venueId })
          .where(inArray(schema.occurrences.id, toMove));
      }
      if (toDrop.length) {
        await tx.delete(schema.occurrences).where(inArray(schema.occurrences.id, toDrop));
      }
      // Verwijzingen meeverhuizen i.p.v. laten cascaden.
      const loserIds = losers.map((e) => e.id);
      await tx.update(schema.shareInvites).set({ eventId: keeper.id })
        .where(inArray(schema.shareInvites.eventId, loserIds));
      // events_in_series heeft (eventId, seriesId) als sleutel, dus een
      // blinde update botst als keeper én loser in dezelfde serie
      // zitten. Eerst de botsers weggooien, dan de rest verhuizen.
      // (`onConflictDoNothing` bestaat alleen op inserts.)
      await tx.delete(schema.eventsInSeries).where(
        and(
          inArray(schema.eventsInSeries.eventId, loserIds),
          inArray(
            schema.eventsInSeries.seriesId,
            db.select({ s: schema.eventsInSeries.seriesId })
              .from(schema.eventsInSeries)
              .where(eq(schema.eventsInSeries.eventId, keeper.id))
          )
        )
      );
      await tx.update(schema.eventsInSeries).set({ eventId: keeper.id })
        .where(inArray(schema.eventsInSeries.eventId, loserIds));
      await tx.delete(schema.events).where(inArray(schema.events.id, loserIds));
    });
  }
  mergedEvents += losers.length;
  movedOcc += toMove.length;
  droppedOcc += toDrop.length;
}

console.log(`\n${APPLY ? 'Samengevoegd' : 'Zou samenvoegen'}: ${mergedEvents} events weg, ${movedOcc} occurrences verplaatst, ${droppedOcc} dubbele occurrences verwijderd`);
if (keptForSave) console.log(`${keptForSave} samenvallende occurrence(s) bewaard omdat er een save aan hing — handmatig nakijken`);
process.exit(0);
