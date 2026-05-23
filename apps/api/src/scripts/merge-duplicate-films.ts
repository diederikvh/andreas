/**
 * One-off merge-script voor bestaande dubbele film-events.
 *
 * Achtergrond: vóór de _film-dedup-helper deed elke film-scraper z'n
 * eigen exact-string match op `events.title`. Suffix-varianten
 * ((ENG SUBS), (4K Restoration)), casing-verschillen en curly-vs-
 * straight apostrofs zorgden dat dezelfde film als meerdere events in
 * de DB belandde. De helper voorkomt nieuwe dupes maar ruimt de oude
 * niet op.
 *
 * Dit script doet dat op een veilige manier:
 *   1. Groepeer alle Film+show events op `normalizeFilmTitle()`.
 *   2. Per collision-groep: kies een winner (meeste occurrences, dan
 *      kortste title, dan oudste createdAt).
 *   3. Re-point alle occurrences van losers naar winner.
 *   4. Re-point share_invites naar winner (conflicten: laat 't oude
 *      record bestaan, delete-cascade ruimt 'm op).
 *   5. Merge events_in_series: voeg loser's series toe aan winner, met
 *      ON CONFLICT DO NOTHING. Daarna delete-cascade ruimt loser's
 *      koppelingen op.
 *   6. Patch winner met description/imageUrl/genres van losers als die
 *      bij de winner null/leeg zijn.
 *   7. Delete losers (cascade ruimt z'n nu-lege FK-refs op).
 *
 * Gebruik:
 *   pnpm tsx --env-file=.env src/scripts/merge-duplicate-films.ts
 *     → dry-run, print wat er zou gebeuren.
 *   pnpm tsx --env-file=.env src/scripts/merge-duplicate-films.ts --commit
 *     → écht executeren.
 *
 * Idempotent: meerdere keren draaien is veilig — na de eerste keer
 * zijn er geen collisions meer en doet 'ie niks.
 */

import { and, eq, inArray, sql as drizzleSql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { decodeHtmlEntities, normalizeFilmTitle } from '../scrapers/_film-dedup.js';

const COMMIT = process.argv.includes('--commit');

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  venueId: string;
  genres: string[];
  createdAt: Date;
  featured: boolean;
}

async function main() {
  console.log(`Mode: ${COMMIT ? 'COMMIT (writes to DB)' : 'DRY-RUN'}\n`);

  // Stap 0: decode HTML-entities in bestaande event-titles. Doen we
  // vóór de collision-detectie, anders matched "The President&#039;s
  // Cake" niet met "The President's Cake" en blijven ze als losse
  // events bestaan. normalizeFilmTitle decodeert wel intern voor de
  // key, maar dat fixt de display-title niet.
  const allEvents = await db
    .select({ id: schema.events.id, title: schema.events.title })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.category, 'Film'),
        eq(schema.events.kind, 'show')
      )
    );
  const entityFixes = allEvents
    .map((e) => ({ ...e, decoded: decodeHtmlEntities(e.title) }))
    .filter((e) => e.decoded !== e.title);
  console.log(`=== Stap 0: entity-decode ===`);
  console.log(`Events met HTML-entities in title: ${entityFixes.length}`);
  for (const e of entityFixes) {
    console.log(`  "${e.title}" → "${e.decoded}"`);
  }
  if (COMMIT && entityFixes.length > 0) {
    for (const e of entityFixes) {
      await db
        .update(schema.events)
        .set({ title: e.decoded })
        .where(eq(schema.events.id, e.id));
    }
    console.log(`  → ${entityFixes.length} titels gedecodeerd.\n`);
  }

  const events = await db
    .select({
      id: schema.events.id,
      title: schema.events.title,
      description: schema.events.description,
      imageUrl: schema.events.imageUrl,
      venueId: schema.events.venueId,
      genres: schema.events.genres,
      createdAt: schema.events.createdAt,
      featured: schema.events.featured,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.category, 'Film'),
        eq(schema.events.kind, 'show')
      )
    );

  // Tel occurrences per event (input voor winner-keuze).
  const occCounts = new Map<string, number>();
  const allOccs = await db
    .select({ eventId: schema.occurrences.eventId })
    .from(schema.occurrences);
  for (const o of allOccs) {
    occCounts.set(o.eventId, (occCounts.get(o.eventId) ?? 0) + 1);
  }

  // Groepeer op normalized key.
  const byKey = new Map<string, EventRow[]>();
  for (const e of events) {
    const key = normalizeFilmTitle(e.title);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(e);
    byKey.set(key, list);
  }

  const collisions = [...byKey.entries()].filter(([_, v]) => v.length > 1);
  console.log(`Total Film+show events: ${events.length}`);
  console.log(`Distinct normalized keys: ${byKey.size}`);
  console.log(`Collision-groepen: ${collisions.length}\n`);

  if (collisions.length === 0) {
    console.log('Niks te mergen. ');
    process.exit(0);
  }

  let totalOccsRepointed = 0;
  let totalShareInvitesRepointed = 0;
  let totalSeriesLinksRepointed = 0;
  let totalEventsDeleted = 0;
  let totalWinnersPatched = 0;

  for (const [key, items] of collisions) {
    // Winner-keuze: meeste occurrences eerst (zo behouden we de event-id
    // waar de meeste saves/share-invites/series-links al aan vast zitten),
    // dan oudste createdAt als tie-break.
    const sorted = [...items].sort((a, b) => {
      const ca = occCounts.get(a.id) ?? 0;
      const cb = occCounts.get(b.id) ?? 0;
      if (ca !== cb) return cb - ca;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);
    const loserIds = losers.map((l) => l.id);

    // Display-titel: kies de kortste variant uit de groep — los van wie
    // er de meeste occurrences had. Zo wint "Sirât" van "Sirāt (2025)"
    // en "Anora" van "Anora (ENG SUBS)" voor de UI.
    const shortestTitle = [...items]
      .map((e) => e.title)
      .sort((a, b) => a.length - b.length)[0];

    console.log(`[${key}]`);
    console.log(
      `  winner: "${winner.title}" (${occCounts.get(winner.id) ?? 0} occs, venue=${winner.venueId}) id=${winner.id}`
    );
    for (const l of losers) {
      console.log(
        `  loser:  "${l.title}" (${occCounts.get(l.id) ?? 0} occs, venue=${l.venueId}) id=${l.id}`
      );
    }
    if (shortestTitle !== winner.title) {
      console.log(`    → display title wordt "${shortestTitle}"`);
    }

    // Plan patches op de winner: vul ontbrekende velden vanuit losers.
    const patch: Partial<typeof schema.events.$inferInsert> = {};
    if (shortestTitle !== winner.title) {
      patch.title = shortestTitle;
    }
    if (!winner.description) {
      const fromLoser = losers.find((l) => l.description)?.description;
      if (fromLoser) patch.description = fromLoser;
    }
    if (!winner.imageUrl || /wiki(p|m)edia\.org/.test(winner.imageUrl)) {
      const fromLoser = losers
        .map((l) => l.imageUrl)
        .find((u) => u && !/wiki(p|m)edia\.org/.test(u));
      if (fromLoser) patch.imageUrl = fromLoser;
    }
    // Union van genres (winner ∪ losers).
    const allGenres = new Set<string>(winner.genres);
    for (const l of losers) for (const g of l.genres) allGenres.add(g);
    if (allGenres.size > winner.genres.length) {
      patch.genres = [...allGenres];
    }
    // Featured: behoud true als één van de losers featured was.
    if (!winner.featured && losers.some((l) => l.featured)) {
      patch.featured = true;
    }

    if (COMMIT) {
      // Transactie per groep — als één stap faalt rollen we deze groep
      // terug. Andere groepen al gemerged blijven gemerged (idempotent).
      await db.transaction(async (tx) => {
        // 1) Occurrences re-pointen.
        const occUpdate = await tx
          .update(schema.occurrences)
          .set({ eventId: winner.id })
          .where(inArray(schema.occurrences.eventId, loserIds))
          .returning({ id: schema.occurrences.id });
        totalOccsRepointed += occUpdate.length;

        // 2) Share-invites re-pointen.
        const siUpdate = await tx
          .update(schema.shareInvites)
          .set({ eventId: winner.id })
          .where(inArray(schema.shareInvites.eventId, loserIds))
          .returning({ id: schema.shareInvites.id });
        totalShareInvitesRepointed += siUpdate.length;

        // 3) Events_in_series: voeg loser's series toe aan winner.
        // ON CONFLICT DO NOTHING want winner kan al een rij hebben.
        const seriesRows = await tx
          .select({ seriesId: schema.eventsInSeries.seriesId })
          .from(schema.eventsInSeries)
          .where(inArray(schema.eventsInSeries.eventId, loserIds));
        for (const row of seriesRows) {
          await tx
            .insert(schema.eventsInSeries)
            .values({ eventId: winner.id, seriesId: row.seriesId })
            .onConflictDoNothing();
        }
        totalSeriesLinksRepointed += seriesRows.length;

        // 4) Patch de winner.
        if (Object.keys(patch).length > 0) {
          await tx
            .update(schema.events)
            .set(patch)
            .where(eq(schema.events.id, winner.id));
          totalWinnersPatched += 1;
        }

        // 5) Delete losers (cascade ruimt z'n nu-lege FK-refs op).
        const del = await tx
          .delete(schema.events)
          .where(inArray(schema.events.id, loserIds))
          .returning({ id: schema.events.id });
        totalEventsDeleted += del.length;
      });
    } else {
      // Dry-run telling.
      const occToMove = losers.reduce(
        (sum, l) => sum + (occCounts.get(l.id) ?? 0),
        0
      );
      totalOccsRepointed += occToMove;
      totalEventsDeleted += losers.length;
      if (Object.keys(patch).length > 0) totalWinnersPatched += 1;
      if (patch.description) console.log(`    + patch description vanuit loser`);
      if (patch.imageUrl) console.log(`    + patch imageUrl vanuit loser`);
      if (patch.genres) console.log(`    + union genres: [${[...allGenres].join(', ')}]`);
      if (patch.featured) console.log(`    + behoud featured=true vanuit loser`);
    }
    console.log();
  }

  // Anti-sanity: vorm geen lege occurrences-foreign-key (zou niet kunnen,
  // we updaten naar bestaande winner-id, maar check 'm).
  if (COMMIT) {
    const orphans = await db
      .select({ id: schema.occurrences.id })
      .from(schema.occurrences)
      .where(
        drizzleSql`NOT EXISTS (SELECT 1 FROM events WHERE events.id = ${schema.occurrences.eventId})`
      );
    if (orphans.length > 0) {
      console.error(`!! ${orphans.length} orphan occurrences gevonden`);
      process.exit(1);
    }
  }

  console.log('─────');
  console.log(`Collision-groepen verwerkt:    ${collisions.length}`);
  console.log(`Occurrences re-pointed:        ${totalOccsRepointed}`);
  console.log(`Share-invites re-pointed:      ${totalShareInvitesRepointed}`);
  console.log(`Series-links overgebracht:     ${totalSeriesLinksRepointed}`);
  console.log(`Winners gepatched:             ${totalWinnersPatched}`);
  console.log(`Loser-events verwijderd:       ${totalEventsDeleted}`);
  console.log();
  console.log(COMMIT ? 'Done.' : 'Dry-run done. Add --commit om uit te voeren.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
