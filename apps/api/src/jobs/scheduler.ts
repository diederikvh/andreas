/**
 * De enige in-process planner van de API.
 *
 * Geen cron-dependency: één timer die zichzelf steeds opnieuw zet op het
 * eerstvolgende tijdstip. Dat rekent per keer uit hoe laat het in
 * Amsterdam is, dus de zomertijd-sprong lost zichzelf op — een vaste
 * interval van 24 uur zou twee keer per jaar een uur verschuiven.
 *
 * **Vereist `min_machines_running = 1` in fly.toml.** Met autostop op
 * nul slaapt de machine tussen requests en gaat er dus niets af. Dat is
 * ook waarom de scrapers extern getriggerd worden; deze taak draait
 * bewust wél intern, zodat een push niet afhangt van een tweede systeem.
 */
import { sendDailyNewPush } from './daily-new-push.js';

/** Lokale tijd waarop de aanwinsten-push de deur uit gaat. */
const PUSH_HOUR = 10;
const TZ = 'Europe/Amsterdam';

/** Het huidige uur in Amsterdam, ongeacht de tijdzone van de server. */
function amsterdamParts(at: Date): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = fmt.format(at).split(':');
  return { hour: Number(h), minute: Number(m) };
}

/**
 * Milliseconden tot het eerstvolgende `PUSH_HOUR:00` in Amsterdam.
 *
 * Werkt door vooruit te tellen in stappen van een minuut in plaats van
 * met een datum-berekening: simpel, en het kan niet misgaan rond de
 * klokwissel omdat elke stap opnieuw naar de lokale tijd kijkt. Het is
 * hooguit 1440 iteraties, één keer per dag.
 */
function msUntilNextRun(from: Date): number {
  const step = 60_000;
  for (let i = 1; i <= 24 * 60; i++) {
    const at = new Date(from.getTime() + i * step);
    const { hour, minute } = amsterdamParts(at);
    if (hour === PUSH_HOUR && minute === 0) return i * step;
  }
  // Onbereikbaar, maar beter een dag wachten dan een strakke lus.
  return 24 * 60 * step;
}

export function startScheduler(): void {
  const schedule = () => {
    const delay = msUntilNextRun(new Date());
    setTimeout(() => {
      void run().finally(schedule);
    }, delay).unref?.();
    const at = new Date(Date.now() + delay).toISOString();
    console.log(`[scheduler] volgende aanwinsten-push om ${at}`);
  };

  const run = async () => {
    try {
      const result = await sendDailyNewPush();
      console.log(
        `[scheduler] aanwinsten-push: ${result.sent} verstuurd`
      );
    } catch (err) {
      // Nooit doorgooien: een mislukte push mag de planner niet stoppen,
      // anders is één storing genoeg om 'm tot de volgende deploy stil te
      // leggen. De job is idempotent per dag, dus morgen weer.
      console.error('[scheduler] aanwinsten-push mislukt', err);
    }
  };

  schedule();
}
