/**
 * Merge de dubbele jsonld-events die zijn ontstaan doordat de uid op
 * ticketUrl gebaseerd was (zie _jsonld-parser.ts). Per cluster
 * (venue, titel, dag) blijft één rij over; ontbrekende velden worden
 * bijgevuld uit de rijen die verdwijnen, zodat we geen ticket-links
 * of images kwijtraken.
 *
 * Dry-run tenzij je `--apply` meegeeft.
 *
 * ponytail: eenmalige migratie, geen generieke merge-engine. De
 * parser-fix voorkomt nieuwe dupes; als een tweede bron ooit hetzelfde
 * patroon krijgt, is dit script het startpunt.
 */
import { createHash } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { extractJsonLdEvents } from '../src/scrapers/_jsonld-parser.js';

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

const venues = (await db.select().from(schema.venues)).filter(
  (v) => (v.scraperConfig as any)?.jsonld?.url
);

let totalDeleted = 0;

for (const v of venues) {
  // Post-fix ids uit de live feed — die bepalen welke rij canoniek is,
  // want die id gaat de scraper voortaan gebruiken.
  const url = (v.scraperConfig as any).jsonld.url as string;
  let liveIds = new Set<string>();
  try {
    const html = await (await fetch(url, { headers: { 'user-agent': UA } })).text();
    liveIds = new Set(
      extractJsonLdEvents(html).map((e) => `evt-jld-${v.id}-${shortHash(e.uid)}`)
    );
  } catch (e) {
    console.warn(`[${v.id}] feed niet op te halen (${(e as Error).message}) — val terug op rijkste rij`);
  }

  const evs = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.venueId, v.id))
    // Vaste volgorde: zonder ORDER BY wisselt de cluster-volgorde per
    // run, en dan is de dry-run geen betrouwbare voorspelling meer.
    .orderBy(asc(schema.events.id));
  if (!evs.length) continue;
  const occ = await db
    .select()
    .from(schema.occurrences)
    .where(inArray(schema.occurrences.eventId, evs.map((e) => e.id)));

  const occsOf = new Map<string, typeof occ>();
  for (const o of occ) occsOf.set(o.eventId, [...(occsOf.get(o.eventId) ?? []), o] as typeof occ);
  const firstStart = (id: string) =>
    (occsOf.get(id) ?? []).reduce<Date | null>((a, o) => (!a || o.startsAt < a ? o.startsAt : a), null);

  // Alleen komende events — verlopen dubbelen vervuilen de agenda niet.
  const now = Date.now();
  const clusters = new Map<string, typeof evs>();
  for (const e of evs) {
    const s = firstStart(e.id);
    if (!s || s.getTime() <= now) continue;
    const k = `${e.title.trim().toLowerCase()}|${s.toISOString().slice(0, 10)}`;
    clusters.set(k, [...(clusters.get(k) ?? []), e] as typeof evs);
  }

  // Compleetheid-score als tiebreak wanneer de feed het event niet meer kent.
  const score = (e: (typeof evs)[number]) =>
    (e.description ? 2 : 0) + (e.imageUrl ? 2 : 0) +
    ((occsOf.get(e.id) ?? []).some((o) => o.ticketUrl) ? 1 : 0);

  for (const [key, members] of clusters) {
    if (members.length < 2) continue;
    const canonical =
      members.find((e) => liveIds.has(e.id)) ??
      [...members].sort((a, b) => score(b) - score(a))[0];
    const losers = members.filter((e) => e.id !== canonical.id);

    // Veiligheidsklem: nooit user-data weggooien.
    const loserOccIds = losers.flatMap((e) => (occsOf.get(e.id) ?? []).map((o) => o.id));
    const saves = loserOccIds.length
      ? await db.select().from(schema.saves).where(inArray(schema.saves.occurrenceId, loserOccIds))
      : [];
    const invites = await db
      .select()
      .from(schema.shareInvites)
      .where(inArray(schema.shareInvites.eventId, losers.map((e) => e.id)));
    if (saves.length || invites.length) {
      console.log(`SKIP  ${key} — user-data: ${saves.length} saves, ${invites.length} invites`);
      continue;
    }

    // Velden bijvullen vanuit de losers.
    const evPatch: Partial<typeof canonical> = {};
    // Alleen een key zetten als er ook echt een waarde is: `= undefined`
    // laat de key wél in het object staan, en drizzle's `.set()` gooit
    // dan "No values to set".
    const donorDesc = losers.find((e) => e.description)?.description;
    if (!canonical.description && donorDesc) evPatch.description = donorDesc;
    const donorImg = losers.find((e) => e.imageUrl)?.imageUrl;
    if (!canonical.imageUrl && donorImg) evPatch.imageUrl = donorImg;

    const keepOcc = (occsOf.get(canonical.id) ?? [])[0];
    const donorOcc = losers.flatMap((e) => occsOf.get(e.id) ?? []);
    const occPatch: { ticketUrl?: string; priceCents?: number } = {};
    if (keepOcc && !keepOcc.ticketUrl) {
      const t = donorOcc.find((o) => o.ticketUrl)?.ticketUrl;
      if (t) occPatch.ticketUrl = t;
    }
    if (keepOcc && keepOcc.priceCents == null) {
      const p = donorOcc.find((o) => o.priceCents != null)?.priceCents;
      if (p != null) occPatch.priceCents = p;
    }

    const live = liveIds.has(canonical.id) ? 'feed' : 'score';
    console.log(`${APPLY ? 'MERGE' : 'DRY  '} ${key}`);
    console.log(`        keep   ${canonical.id}  (${live})`);
    if (Object.keys(evPatch).length) console.log(`        event  += ${Object.keys(evPatch).join(', ')}`);
    if (Object.keys(occPatch).length) console.log(`        occ    += ${Object.keys(occPatch).join(', ')}`);
    for (const l of losers) console.log(`        delete ${l.id}`);

    if (APPLY) {
      // Eén transactie per cluster: als de backfill klapt mag de delete
      // niet doorgaan (en omgekeerd), anders blijft er een halve merge
      // staan waar geen dry-run meer bij past.
      await db.transaction(async (tx) => {
        if (Object.keys(evPatch).length) {
          await tx.update(schema.events).set(evPatch).where(eq(schema.events.id, canonical.id));
        }
        if (keepOcc && Object.keys(occPatch).length) {
          await tx.update(schema.occurrences).set(occPatch).where(eq(schema.occurrences.id, keepOcc.id));
        }
        await tx.delete(schema.events).where(inArray(schema.events.id, losers.map((e) => e.id)));
      });
    }
    totalDeleted += losers.length;
  }
}

console.log(`\n${APPLY ? 'Verwijderd' : 'Zou verwijderen'}: ${totalDeleted} events`);
process.exit(0);
