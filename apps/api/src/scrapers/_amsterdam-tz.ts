/**
 * Parse een ISO-string als Amsterdam-local-time naar het juiste UTC-moment.
 *
 * Veel ticket-platforms returnen naive ISO-strings ('2026-05-29T20:15:00',
 * géén Z, géén offset) — soms zelfs met een misleidende 'Z'-suffix terwijl
 * de tijd Amsterdam-local bedoeld is. Node's `new Date(...)` interpreteert
 * die als UTC, waardoor events 2u (DST) of 1u (winter) verkeerd opgeslagen
 * worden.
 *
 * Deze helper pakt de wall-time uit de string, plakt 'm op een UTC-kandidaat
 * en trekt vervolgens de Amsterdam-tz-offset (via Intl) eraf zodat de
 * resulterende Date-instance het juiste UTC-moment vasthoudt.
 *
 * Gebruikt door: stager, boomchicago. Voeg toe wanneer je een scraper
 * tegenkomt waarvan de bron-API ambigue tijden returnt.
 */
export function parseAmsterdamLocal(iso: string | null | undefined): Date {
  if (!iso) return new Date(NaN);
  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) return new Date(iso);
  const [, y, mo, d, h, min, s] = m;
  // Kandidaat-tijdstip alsof het UTC was. Wall-time klopt; alleen de
  // tz-offset moet er nog af.
  const guess = new Date(
    Date.UTC(+y, +mo - 1, +d, +h, +min, +(s ?? '0'))
  );
  // Vraag Intl wat de Amsterdam-offset op dat moment is (in minuten dat
  // Amsterdam vóór ligt op UTC: +60 winter, +120 DST).
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'longOffset',
  });
  const parts = fmt.formatToParts(guess);
  const tzName =
    parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const offMatch = tzName.match(/GMT([+-])(\d+):?(\d+)?/);
  let offsetMin = 0;
  if (offMatch) {
    const sign = offMatch[1] === '+' ? 1 : -1;
    offsetMin = sign * (+offMatch[2] * 60 + (+(offMatch[3] ?? '0')));
  }
  return new Date(guess.getTime() - offsetMin * 60_000);
}

/**
 * Voor JSON-LD bronnen (theater.ts) waar conventie per venue
 * verschilt: Meervaart publiceert correct UTC (`Z`), NDSM publiceert
 * naive Amsterdam-local zonder offset, anderen mengen. Detect:
 *  - Heeft expliciete tz-marker (Z, +HH:MM, -HH:MM) → vertrouw 'm,
 *    `new Date(...)` parsed dan correct.
 *  - Geen marker → behandel als Amsterdam-local via
 *    `parseAmsterdamLocal`.
 *
 * NIET gebruiken voor Stager/FH-bronnen: die publiceren een Z-suffix
 * die Amsterdam-local bedoelt (misleidend) — die moet altijd via
 * `parseAmsterdamLocal` om de offset eraf te halen.
 */
export function parseIsoFlexible(iso: string | null | undefined): Date {
  if (!iso) return new Date(NaN);
  if (/(Z|[+-]\d{2}:?\d{2})\s*$/.test(iso.trim())) {
    return new Date(iso);
  }
  return parseAmsterdamLocal(iso);
}
