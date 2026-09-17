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

import { db } from '../db/index.js';
import { sendPushToUser } from '../push.js';

/** Hoe lang van tevoren "vanavond" vertrekt. Genoeg om je om te kleden,
    te weinig om het alweer vergeten te zijn. */
const TONIGHT_HOURS_BEFORE = 3;

/** Hoe laat de avond ervoor. Niet 's ochtends: je maakt je plannen voor
    morgen aan het eind van vandaag, niet aan het begin. */
const DAY_BEFORE_HOUR = 18;

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
           ) AS is_going
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
        OR (r.kind = 'vanavond' AND u.push_tonight))
      -- De automatische gelden zolang je 'm nog hebt gered. Haal je het
      -- hartje weg, dan vertrekt er niets meer.
      AND (r.kind = 'zelf' OR EXISTS (
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

  const sent: ReminderSend[] = [];
  for (const row of due.rows ?? []) {
    const time = new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(row.starts_at));

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
          : row.note?.trim()
            ? row.note.trim()
            : row.title;

    const body =
      row.kind === 'dag-ervoor'
        ? `${time} bij ${row.venue_name}.`
        : row.kind === 'vanavond'
          ? going
            ? `${row.title} — ${row.venue_name}.`
            : `${row.title} bij ${row.venue_name}. Je had 'm gered.`
          : `${row.title}, ${row.venue_name}.`;

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

/** Wat de planner elke paar minuten doet. */
export async function runReminders(
  opts: { dryRun?: boolean } = {}
): Promise<{ added: number; sent: ReminderSend[] }> {
  const added = opts.dryRun ? 0 : await ensureReminderRows();
  const sent = await sendDueReminders(opts);
  return { added, sent };
}
