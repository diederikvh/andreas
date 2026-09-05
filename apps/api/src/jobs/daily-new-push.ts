/**
 * De dagelijkse aanwinsten-push.
 *
 * Eén keer per ochtend: "er staat iets nieuws voor je klaar" met een
 * deeplink naar /new. Bedoeld als het startschot van de dagelijkse lus —
 * je beoordeelt wat er bij kwam, en dat voedt je smaakprofiel.
 *
 * Drie regels bepalen wie er een push krijgt:
 *
 *  1. **Stilte bij nul.** Is er sinds jouw laatste bezoek aan /new niets
 *     bijgekomen dat je nog niet beoordeeld hebt, dan gebeurt er niets.
 *     Een digest die élke dag moet vullen wordt ruis, en dan zet je 'm
 *     uit — waarna de dagen dat er wél iets is ook niet meer aankomen.
 *  2. **Niet als je de app vandaag al open had.** Dan heb je de strook
 *     op Vandaag al gezien en is de push een herhaling.
 *  3. **Eén per dag.** `lastDailyPushAt` is het slot; de cron mag dus
 *     opnieuw draaien na een storing zonder dubbel te sturen.
 *
 * Alles in één query in plaats van per gebruiker: de telling loopt over
 * de hele users-tabel tegelijk, zodat dit ook bij duizenden gebruikers
 * één round-trip blijft.
 *
 * **Bekende beperking**: de baan-voorkeur (film/theater/live/club/kunst)
 * staat in AsyncStorage op het toestel, niet op de user-rij. De server
 * kan er dus niet op filteren en het getal in de push telt álle banen.
 * Wie z'n lijst tot theater heeft beperkt kan "12 nieuw" lezen en er
 * drie aantreffen. Op te lossen door die voorkeur mee te sturen naar
 * `PATCH /me`; nu nog niet gedaan omdat het filter een paar dagen oud is
 * en vrijwel niemand 'm heeft aangezet.
 */
import { inArray, sql } from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { sendPushToUsers } from '../push.js';

/**
 * Hoe ver we maximaal terugkijken: één dag, niet de dertig van
 * `/events/new`.
 *
 * Dit is een dagelijks bericht en moet dus over één nacht gaan. De
 * scrapers draaien om 02:00 en de push om 10:00, dus 24 uur dekt precies
 * één ronde. Met een weekvenster liep het in productie op tot 373 — dat
 * is geen uitnodiging maar een muur, en de pagina zelf capt de lijst
 * niet voor niets op vijftien.
 *
 * Wie langer weg was mist dus niks: op /new staat het volledige venster
 * sinds z'n vorige sessie nog gewoon.
 */
const MAX_LOOKBACK_DAYS = 1;

export type DailyPushResult = {
  /** Gebruikers die een push kregen. */
  sent: number;
  /** Kandidaten die afvielen omdat er niets nieuws voor ze was. */
  skippedEmpty: number;
  /** Verdeling van de aantallen, voor het admin-logboek. */
  counts: { userId: string; newCount: number }[];
};

/**
 * Begin van vandaag in Amsterdam, als UTC-moment. De cron draait om
 * 10:00 lokale tijd, dus "vandaag" moet ook lokaal zijn — met een
 * UTC-middernacht zou de grens er in de zomer twee uur naast zitten.
 */
function amsterdamDayStart(): Date {
  const now = new Date();
  const ams = new Date(
    now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
  );
  const offsetMs = now.getTime() - ams.getTime();
  ams.setHours(0, 0, 0, 0);
  return new Date(ams.getTime() + offsetMs);
}

export async function sendDailyNewPush(
  opts: { dryRun?: boolean } = {}
): Promise<DailyPushResult> {
  const dayStart = amsterdamDayStart();

  // Kandidaten + telling in één keer. De telling spiegelt `/events/new`:
  // occurrences die ná jouw venster zijn aangemaakt, alleen wat nog komt,
  // ontdubbeld op event, en zonder wat je al beoordeeld hebt — want een
  // ja of nee is een oordeel over het event, niet over die ene datum.
  const result = await db.execute(sql`
    SELECT u.id AS user_id, COUNT(DISTINCT o.event_id)::int AS new_count
    FROM users u
    JOIN push_tokens pt ON pt.user_id = u.id
    JOIN occurrences o
      -- "Nieuw" = sinds je hier voor het laatst iets van meekreeg. Drie
      -- momenten tellen mee en de laatste wint: je bezoek aan /new, de
      -- vorige push, en je laatste app-opening (dan zag je de strook op
      -- Vandaag). Zonder dat laatste zou iemand die dagelijks de app
      -- opent bij z'n eerste gemiste dag ineens weken opgeteld krijgen.
      ON o.created_at > GREATEST(
           COALESCE(u.last_seen_new_at, '-infinity'::timestamptz),
           COALESCE(u.last_daily_push_at, '-infinity'::timestamptz),
           COALESCE(u.last_seen_at, '-infinity'::timestamptz),
           NOW() - INTERVAL '${sql.raw(String(MAX_LOOKBACK_DAYS))} days'
         )
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE (u.last_seen_at IS NULL OR u.last_seen_at < ${dayStart})
      AND (u.last_daily_push_at IS NULL OR u.last_daily_push_at < ${dayStart})
      AND COALESCE(
            o.ends_at,
            o.starts_at + CASE WHEN e.category = 'Muziek'
                               THEN INTERVAL '4 hours'
                               ELSE INTERVAL '1 hour' END
          ) >= NOW()
      AND NOT EXISTS (
        SELECT 1 FROM saves s
        JOIN occurrences so ON so.id = s.occurrence_id
        WHERE s.user_id = u.id AND so.event_id = o.event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dismisses d
        JOIN occurrences dobj ON dobj.id = d.occurrence_id
        WHERE d.user_id = u.id AND dobj.event_id = o.event_id
      )
    GROUP BY u.id
    HAVING COUNT(DISTINCT o.event_id) > 0
  `);

  // De Neon-driver geeft `{ rows }` terug, node-postgres ook — maar een
  // paar drivers leveren de array direct. Beide afvangen scheelt een
  // verrassing bij een driver-wissel.
  const raw = (Array.isArray(result) ? result : result.rows) as {
    user_id: string;
    new_count: number;
  }[];
  const counts = raw.map((r) => ({
    userId: r.user_id,
    newCount: Number(r.new_count),
  }));

  if (counts.length === 0 || opts.dryRun) {
    return { sent: 0, skippedEmpty: 0, counts };
  }

  // Groeperen op aantal: één Expo-batch per tekst in plaats van per
  // gebruiker. Het aantal ís de tekst, dus dat scheelt flink.
  const byCount = new Map<number, string[]>();
  for (const c of counts) {
    const list = byCount.get(c.newCount) ?? [];
    list.push(c.userId);
    byCount.set(c.newCount, list);
  }

  for (const [n, userIds] of byCount) {
    await sendPushToUsers(userIds, {
      title: n === 1 ? 'Eén nieuwe aanwinst' : `${n} nieuwe aanwinsten`,
      // Geen titels in de body: welk event bovenaan staat hangt van je
      // smaakprofiel af en dat rekenen we hier niet uit. "Kijk even" is
      // eerlijker dan één willekeurige naam die misschien niks voor je is.
      body: 'Kijk even wat er bij kwam.',
      data: { url: '/new' },
      // Zelfde getal als in de titel: het app-icoon toont wat er te
      // beoordelen staat. De app zet 'm daarna zelf bij elke wijziging
      // opnieuw, dus hij loopt mee naar nul terwijl je de lijst afwerkt.
      badge: n,
    });
  }

  await db
    .update(schema.users)
    .set({ lastDailyPushAt: new Date() })
    .where(
      inArray(
        schema.users.id,
        counts.map((c) => c.userId)
      )
    );

  return { sent: counts.length, skippedEmpty: 0, counts };
}
