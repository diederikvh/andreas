/**
 * Herinneringen klaarzetten en versturen.
 *
 * Twee stappen in één doorloop, en met opzet in deze volgorde:
 *
 *  1. **Bijzetten.** Voor elke avond die iemand heeft gered of waar hij
 *     "ik ga" op tikte staat een rij klaar. Dat gebeurt hier en niet op
 *     het moment van redden, want dan zou een avond die je drie weken
 *     geleden redde nooit een rij krijgen, en zou het uitzetten van een
 *     schakelaar alleen gelden voor wat je daarna redt.
 *  2. **Versturen** wat rijp is en nog niet weg.
 *
 * Het bijzetten is een blinde insert met ON CONFLICT DO NOTHING. Daardoor
 * hoeft deze job niets te onthouden: draait hij twee keer in een minuut,
 * of een dag niet, dan komt er hetzelfde uit.
 *
 * Wie z'n hartje weghaalt houdt de rij, maar die vertrekt niet: de
 * verzendquery checkt opnieuw of de save of het "ik ga" er nog is. Rijen
 * opruimen bij het weghalen zou een tweede plek zijn waar dit moet
 * kloppen, en dat is precies waar zulke dingen scheef gaan.
 */
import { sql } from 'drizzle-orm';

import { ALERT_MATCH, GENRE_ALIAS_CTE, titleHasName } from '../alerts/match.js';
import { whyMatched } from '../alerts/service.js';
import { db } from '../db/index.js';
import { sendPushToUser } from '../push.js';

/** Hoe lang van tevoren "vanavond" vertrekt. Genoeg om je om te kleden,
    te weinig om het alweer vergeten te zijn. */
const TONIGHT_HOURS_BEFORE = 3;

/** Hoe laat de avond ervoor. Niet 's ochtends: je maakt je plannen voor
    morgen aan het eind van vandaag, niet aan het begin. */
const DAY_BEFORE_HOUR = 18;

/**
 * Wanneer nieuws (artiest of regel) vertrekt: de eerstvolgende 10:00 in
 * Amsterdam. De scrapers draaien 's nachts, en "Adje komt naar Paradiso"
 * om kwart over twee is geen dienst. Bijvangst: alles wat in één nacht
 * binnenkomt staat op hetzelfde moment klaar en gaat als één bundel weg,
 * dus er vertrekt hooguit één nieuws-push per persoon per dag.
 *
 * ponytail: wat overdag binnenkomt wacht tot morgen 10:00; een event dat
 * vóór dat moment al begint valt daardoor weg. Zeldzaam genoeg.
 */
const NEXT_MORNING = sql.raw(`(
  (DATE_TRUNC('day', NOW() AT TIME ZONE 'Europe/Amsterdam')
    + CASE WHEN (NOW() AT TIME ZONE 'Europe/Amsterdam')::time < TIME '10:00'
           THEN INTERVAL '10 hours' ELSE INTERVAL '1 day 10 hours' END)
  AT TIME ZONE 'Europe/Amsterdam'
)`);

export type ReminderSend = {
  id: string;
  userId: string;
  kind: string;
  title: string;
};

/**
 * Rijen bijzetten voor alles wat iemand heeft gered of waar hij heen gaat.
 *
 * Alleen voor avonden die nog moeten komen én waarvan het moment zelf nog
 * niet voorbij is: een herinnering die je meteen bij het aanmaken al te
 * laat is hoort niet te vertrekken. Vandaar de `fire_at > now()` in de
 * SELECT en niet alleen in de verzendstap.
 */
export async function ensureReminderRows(): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO reminders (id, user_id, occurrence_id, kind, fire_at)
    SELECT
      gen_random_uuid()::text,
      w.user_id,
      w.occurrence_id,
      w.kind::reminder_kind,
      w.fire_at
    FROM (
      SELECT
        i.user_id,
        i.occurrence_id,
        k.kind,
        CASE k.kind
          WHEN 'vanavond' THEN o.starts_at - INTERVAL '${sql.raw(String(TONIGHT_HOURS_BEFORE))} hours'
          -- De avond ervoor om 18:00 Amsterdamse tijd. Via de lokale
          -- datum rekenen en niet via "starts_at min 24 uur", anders
          -- schuift het uur mee met de begintijd van de voorstelling.
          ELSE (
            (DATE_TRUNC('day', o.starts_at AT TIME ZONE 'Europe/Amsterdam')
              - INTERVAL '1 day'
              + INTERVAL '${sql.raw(String(DAY_BEFORE_HOUR))} hours')
            AT TIME ZONE 'Europe/Amsterdam'
          )
        END AS fire_at
      -- Alleen de bronnen die aanstaan. Staat een avond in allebei, dan
      -- is één aanstaande bron genoeg en houdt de UNION er één rij van
      -- over.
      FROM (
        SELECT s.user_id, s.occurrence_id FROM saves s
        JOIN users su ON su.id = s.user_id AND su.push_for_saves
        UNION
        SELECT a.user_id, a.occurrence_id FROM attendance a
        JOIN users au ON au.id = a.user_id AND au.push_for_going
      ) i
      JOIN occurrences o ON o.id = i.occurrence_id
      JOIN events e ON e.id = o.event_id
      JOIN users u ON u.id = i.user_id
      CROSS JOIN (VALUES ('dag-ervoor'), ('vanavond')) AS k(kind)
      WHERE o.starts_at > NOW()
        AND o.status <> 'cancelled'
        AND e.published
        AND ((k.kind = 'dag-ervoor' AND u.push_day_before)
          OR (k.kind = 'vanavond' AND u.push_tonight))
    ) w
    WHERE w.fire_at > NOW()
    ON CONFLICT (user_id, occurrence_id, kind) DO NOTHING
    RETURNING id
  `);
  return rows.rows?.length ?? 0;
}

/**
 * Rijen bijzetten voor nieuwe avonden van artiesten die je volgt.
 *
 * Alleen occurrences die ná je volg-moment zijn toegevoegd. Wat er al
 * stond toen je op volgen tikte zie je op z'n pagina; daar hoef je geen
 * melding voor. Zonder die regel krijgt iedereen die iemand volgt meteen
 * een stapel meldingen over avonden die hij net zelf heeft bekeken.
 *
 * En niets ouder dan zeven dagen: draait dit een week niet, dan wil je
 * geen inhaalslag maar de draad weer oppakken.
 */
export async function ensureArtistRows(): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO reminders (id, user_id, occurrence_id, kind, fire_at)
    -- Eén melding per event, niet per avond. Tame Impala die drie
    -- avonden achter elkaar in Ahoy staat is één nieuwtje; drie keer
    -- bellen is de snelste manier om iemand z'n meldingen te laten
    -- uitzetten. We pakken de vroegste avond; de rest staat op de
    -- eventpagina waar de melding heen wijst.
    SELECT DISTINCT ON (f.user_id, o.event_id)
      gen_random_uuid()::text, f.user_id, o.id, 'artiest'::reminder_kind, ${NEXT_MORNING}
    FROM artist_follows f
    JOIN users u ON u.id = f.user_id AND u.push_artists
    JOIN occurrences o ON o.created_at > f.created_at
      AND o.created_at > NOW() - INTERVAL '7 days'
      AND o.starts_at > NOW()
      AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    JOIN artists ar ON ar.id = f.artist_id
    WHERE (
        (jsonb_typeof(o.lineup) = 'array' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.lineup) le
          WHERE le->>'artistId' = f.artist_id
        ))
        -- Maar een op de vijf avonden heeft een gekoppelde line-up; bij een
        -- concert is de titel meestal gewoon de naam.
        OR ${sql.raw(titleHasName('ar.name'))}
      )
      -- Een regel vond dit event al: één melding per event is genoeg.
      AND NOT EXISTS (
        SELECT 1 FROM reminders r JOIN occurrences ro ON ro.id = r.occurrence_id
        WHERE r.user_id = f.user_id AND ro.event_id = o.event_id AND r.kind = 'regel'
      )
    ORDER BY f.user_id, o.event_id, o.starts_at
    ON CONFLICT (user_id, occurrence_id, kind) DO NOTHING
    RETURNING id
  `);
  return rows.rows?.length ?? 0;
}

/**
 * Rijen bijzetten voor nieuw aanbod dat bij een meldingsregel past.
 *
 * Zelfde vorm als bij artiesten: alleen occurrences die ná het aanmaken
 * van de regel binnenkwamen (wat er al stond zag je in de preview), niets
 * ouder dan zeven dagen, en één melding per event. Wat de regel precies
 * vangt staat in `alerts/match.ts`.
 *
 * Niet voor events waar je al een melding over kreeg (ook niet via een
 * gevolgde artiest), die je al gered hebt, of die je wegveegde.
 */
export async function ensureAlertRows(): Promise<number> {
  const rows = await db.execute(sql`
    WITH ${GENRE_ALIAS_CTE}
    INSERT INTO reminders (id, user_id, occurrence_id, kind, fire_at, alert_id)
    SELECT DISTINCT ON (a.user_id, o.event_id)
      gen_random_uuid()::text, a.user_id, o.id, 'regel'::reminder_kind, ${NEXT_MORNING}, a.id
    FROM alerts a
    JOIN occurrences o ON o.created_at > a.created_at
      AND o.created_at > NOW() - INTERVAL '7 days'
      AND o.starts_at > NOW()
      AND o.status <> 'cancelled'
    JOIN events e ON e.id = o.event_id AND e.published
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id) AND v.published
    WHERE a.active
      -- Oude smaakregels (van de keurder) doen niets tot ze opnieuw zijn
      -- ingesteld: zonder genre, artiest of trefwoord zouden ze alles vangen.
      AND a.taste IS NULL
      AND ${ALERT_MATCH}
      AND NOT EXISTS (
        SELECT 1 FROM reminders r JOIN occurrences ro ON ro.id = r.occurrence_id
        WHERE r.user_id = a.user_id AND ro.event_id = o.event_id
          AND r.kind IN ('artiest', 'regel')
      )
      AND NOT EXISTS (
        SELECT 1 FROM saves s JOIN occurrences so ON so.id = s.occurrence_id
        WHERE s.user_id = a.user_id AND so.event_id = o.event_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM dismisses d JOIN occurrences dobj ON dobj.id = d.occurrence_id
        WHERE d.user_id = a.user_id AND dobj.event_id = o.event_id
      )
    ORDER BY a.user_id, o.event_id, o.starts_at
    ON CONFLICT (user_id, occurrence_id, kind) DO NOTHING
    RETURNING id
  `);
  const ids = (rows.rows ?? []).map((r) => (r as { id: string }).id);
  if (ids.length) await annotateAlertRows(ids);
  return ids.length;
}

/**
 * De reden bij een klaargezette melding: wát van de regel matchte ("Met
 * Pixies", "folk, via Abigail Lapell"). Staat in `note`, en daar lezen de
 * push en "Gevonden voor jou" hem. Zonder ids: alles van de laatste 30
 * dagen dat nog geen reden heeft.
 */
export async function annotateAlertRows(ids?: string[]): Promise<number> {
  const res = await db.execute<{
    id: string; a_genres: string[] | null; artist_names: string[] | null; keywords: string[] | null; label: string;
    title: string; category: string; e_genres: string[]; description: string | null;
    lineup: string[] | null; hl_name: string | null; hl_genres: string[] | null;
  }>(sql`
    SELECT r.id, a.genres AS a_genres, a.artist_names, a.keywords, a.label,
      e.title, e.category::text AS category, e.genres AS e_genres, e.description,
      (SELECT array_agg(le->>'name') FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup ELSE '[]'::jsonb END) le) AS lineup,
      hl.name AS hl_name, hl.genres AS hl_genres
    FROM reminders r
    JOIN alerts a ON a.id = r.alert_id
    JOIN occurrences o ON o.id = r.occurrence_id
    JOIN events e ON e.id = o.event_id
    LEFT JOIN LATERAL (
      SELECT ar.name, ar.genres FROM artists ar
      WHERE cardinality(ar.genres) > 0
        AND (ar.id = CASE WHEN jsonb_typeof(o.lineup) = 'array' THEN o.lineup->0->>'artistId' END
             OR lower(ar.name) = lower(e.title))
      LIMIT 1
    ) hl ON true
    WHERE r.kind = 'regel' AND r.note IS NULL
      AND ${ids ? sql`r.id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})` : sql`r.created_at > NOW() - INTERVAL '30 days'`}
  `);
  for (const r of res.rows) {
    const note = whyMatched(
      { genres: r.a_genres, artistNames: r.artist_names, keywords: r.keywords, label: r.label },
      {
        title: r.title,
        category: r.category,
        genres: r.e_genres ?? [],
        description: r.description,
        lineup: r.lineup ?? [],
        headliner: r.hl_name ? { name: r.hl_name, genres: r.hl_genres ?? [] } : null,
      }
    );
    await db.execute(sql`UPDATE reminders SET note = ${note} WHERE id = ${r.id}`);
  }
  return res.rows.length;
}

/**
 * Alles versturen wat rijp is.
 *
 * De schakelaars worden hier nóg een keer gecheckt. Dat is niet dubbelop:
 * tussen bijzetten en versturen zit soms weken, en wie in die tijd de
 * schakelaar omzet hoort de al klaargezette rijen ook niet meer te
 * krijgen.
 *
 * `LIMIT 200` is een noodrem, geen paginering: staan er meer klaar dan
 * dat, dan is er iets grondig mis en wil je niet dat één doorloop de hele
 * Expo-quota opmaakt. De volgende tick pakt de rest.
 */
export async function sendDueReminders(
  opts: { dryRun?: boolean } = {}
): Promise<ReminderSend[]> {
  const due = await db.execute<{
    id: string;
    user_id: string;
    kind: string;
    event_id: string;
    title: string;
    venue_name: string;
    starts_at: Date;
    note: string | null;
    is_going: boolean;
    artist_name: string | null;
    alert_label: string | null;
  }>(sql`
    SELECT r.id, r.user_id, r.kind::text AS kind, r.note,
           e.id AS event_id, e.title, v.name AS venue_name, o.starts_at,
           -- Een hartje is een interessesignaal, geen belofte om te gaan.
           -- "Ik ga" is de trede erboven, en alleen daar mag de melding
           -- ervan uitgaan dat je komt. Op dit moment hangt 35 van de 45
           -- herinneringen aan puur een hartje, dus dat verschil is niet
           -- theoretisch.
           EXISTS (
             SELECT 1 FROM attendance a
             WHERE a.user_id = r.user_id AND a.occurrence_id = r.occurrence_id
           ) AS is_going,
           -- Bij een artiest-melding: wélke artiest het was. De eerste
           -- die je volgt is genoeg; staan er twee in de line-up, dan is
           -- dat een detail dat de melding niet beter maakt. Geen line-up?
           -- Dan de gevolgde artiest wiens naam in de titel staat.
           COALESCE(
             (
               SELECT ar.name FROM jsonb_array_elements(o.lineup) le
               JOIN artists ar ON ar.id = le->>'artistId'
               JOIN artist_follows af
                 ON af.artist_id = ar.id AND af.user_id = r.user_id
               WHERE jsonb_typeof(o.lineup) = 'array'
               LIMIT 1
             ),
             (
               SELECT ar.name FROM artist_follows af
               JOIN artists ar ON ar.id = af.artist_id
               WHERE af.user_id = r.user_id AND ${sql.raw(titleHasName('ar.name'))}
               LIMIT 1
             )
           ) AS artist_name,
           (SELECT al.label FROM alerts al WHERE al.id = r.alert_id) AS alert_label
    FROM reminders r
    JOIN occurrences o ON o.id = r.occurrence_id
    JOIN events e ON e.id = o.event_id
    JOIN venues v ON v.id = COALESCE(o.venue_id, e.venue_id)
    JOIN users u ON u.id = r.user_id
    WHERE r.sent_at IS NULL
      AND r.fire_at <= NOW()
      -- Niet meer versturen voor iets dat al geweest is. Draait de job een
      -- nacht niet, dan wil je 's ochtends geen "vanavond" voor gisteren.
      AND o.starts_at > NOW()
      AND o.status <> 'cancelled'
      AND e.published AND v.published
      AND (r.kind = 'zelf'
        OR (r.kind = 'dag-ervoor' AND u.push_day_before)
        OR (r.kind = 'vanavond' AND u.push_tonight)
        OR (r.kind = 'artiest' AND u.push_artists)
        -- Een regel die je uitzette houdt z'n klaargezette meldingen voor
        -- zich; verwijderen ruimt ze via de cascade al op.
        OR (r.kind = 'regel' AND EXISTS (
          SELECT 1 FROM alerts al WHERE al.id = r.alert_id AND al.active
        )))
      -- De automatische gelden zolang je 'm nog hebt gered. Haal je het
      -- hartje weg, dan vertrekt er niets meer.
      AND (r.kind IN ('zelf', 'artiest', 'regel') OR EXISTS (
        SELECT 1 FROM saves s
        WHERE s.user_id = r.user_id AND s.occurrence_id = r.occurrence_id
          AND u.push_for_saves
        UNION ALL
        SELECT 1 FROM attendance a
        WHERE a.user_id = r.user_id AND a.occurrence_id = r.occurrence_id
          AND u.push_for_going
      ))
    ORDER BY r.fire_at
    LIMIT 200
  `);

  const rows = due.rows ?? [];
  const sent: ReminderSend[] = [];

  // Nieuws (artiest + regel) gaat per persoon als één bericht. Het staat
  // allemaal op 10:00 klaar, dus zonder bundelen krijg je na een drukke
  // nacht vijf pushes achter elkaar.
  const news = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.kind !== 'artiest' && row.kind !== 'regel') continue;
    news.set(row.user_id, [...(news.get(row.user_id) ?? []), row]);
  }
  for (const [userId, items] of news) {
    const payload = newsPayload(items);
    if (!opts.dryRun) {
      try {
        await sendPushToUser(userId, payload);
      } catch (err) {
        console.error('[reminders] versturen mislukt', userId, err);
        continue;
      }
      await db.execute(
        sql`UPDATE reminders SET sent_at = NOW() WHERE id IN ${items.map((i) => i.id)}`
      );
    }
    for (const i of items) {
      sent.push({ id: i.id, userId, kind: i.kind, title: payload.title });
    }
  }

  for (const row of rows) {
    if (row.kind === 'artiest' || row.kind === 'regel') continue;
    const time = formatTime(row.starts_at);
    const when = formatDay(row.starts_at);
    const going = row.is_going;
    const title =
      row.kind === 'dag-ervoor'
        ? going
          ? `Morgen ga je naar ${row.title}`
          : `Morgen: ${row.title}`
        : row.kind === 'vanavond'
          ? going
            ? `Vanavond om ${time}`
            : `Vanavond om ${time} — als je wil`
          : row.note?.trim() || row.title;

    const body =
      row.kind === 'dag-ervoor'
        ? `${time} bij ${row.venue_name}.`
        : row.kind === 'vanavond'
          ? going
            ? `${row.title} — ${row.venue_name}.`
            : `${row.title} bij ${row.venue_name}. Je had 'm geliked.`
          : // Een herinnering die jij zelf zet heeft geen notitie meer
            // (dat veld is uit de app), dus draagt de tekst het antwoord
            // op "wanneer was het eigenlijk". Mét notitie is die de kop
            // en vertelt de tekst waar het over ging.
            row.note?.trim()
            ? `${row.title} — ${when} om ${time}.`
            : `${when} om ${time} bij ${row.venue_name}.`;

    if (!opts.dryRun) {
      try {
        await sendPushToUser(row.user_id, {
          title,
          body,
          data: { url: `/event/${row.event_id}` },
        });
      } catch (err) {
        // Eén stuk token mag de rest van de lading niet tegenhouden.
        console.error('[reminders] versturen mislukt', row.id, err);
        continue;
      }
      await db.execute(
        sql`UPDATE reminders SET sent_at = NOW() WHERE id = ${row.id}`
      );
    }
    sent.push({
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      title,
    });
  }
  return sent;
}

function formatTime(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d));
}

function formatDay(d: Date): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: 'numeric',
    month: 'long',
  }).format(new Date(d));
}

type NewsRow = {
  kind: string;
  /** Een reden bij de melding (oude rijen: van de keurder). */
  note: string | null;
  event_id: string;
  title: string;
  venue_name: string;
  starts_at: Date;
  artist_name: string | null;
  alert_label: string | null;
};

/** De tekst van een nieuws-push: één event uitgeschreven, meer gebundeld. */
export function newsPayload(items: NewsRow[]): {
  title: string;
  body: string;
  data: { url: string };
} {
  if (items.length > 1) {
    const named = items
      .slice(0, 2)
      .map((i) => `${i.title} (${i.venue_name})`)
      .join(', ');
    const rest = items.length - 2;
    return {
      title: `${items.length} nieuwe dingen voor jou`,
      body: rest > 0 ? `${named} en ${rest} meer.` : `${named}.`,
      // Naar "Gevonden voor jou" op het meldingenscherm, niet naar /new:
      // daar stonden deze events tussen al het andere nieuwe aanbod.
      data: { url: '/meldingen' },
    };
  }
  const row = items[0];
  const at = `${formatDay(row.starts_at)} om ${formatTime(row.starts_at)}`;
  if (row.kind === 'regel') {
    return {
      title: `${row.title} bij ${row.venue_name}`,
      body: row.note
        ? `${at}. ${row.note}`
        : `${at}. Past bij je melding: ${row.alert_label ?? 'een regel die je instelde'}.`,
      data: { url: `/event/${row.event_id}` },
    };
  }
  return {
    title: row.artist_name
      ? `${row.artist_name} komt naar ${row.venue_name}`
      : `Nieuw: ${row.title}`,
    body: `${at}. Je volgt ${row.artist_name ?? 'deze artiest'}.`,
    data: { url: `/event/${row.event_id}` },
  };
}

/** Wat de planner elke paar minuten doet. */
export async function runReminders(
  opts: { dryRun?: boolean } = {}
): Promise<{ added: number; sent: ReminderSend[] }> {
  const added = opts.dryRun
    ? 0
    : (await ensureReminderRows()) +
      (await ensureArtistRows()) +
      (await ensureAlertRows());
  const sent = await sendDueReminders(opts);
  return { added, sent };
}
