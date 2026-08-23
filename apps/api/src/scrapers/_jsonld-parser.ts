/**
 * JSON-LD Schema.org Event-extractor. Pakt alle
 * `<script type="application/ld+json">` blocks uit een HTML-pagina,
 * parst ze (verdraagt invalid JSON, slaat dat block over) en haalt
 * eruit elk object met `@type` ending op `Event` — recursief door
 * `@graph` arrays.
 *
 * Subset van Schema.org Event we gebruiken:
 *   name, description, startDate, endDate, image, url,
 *   offers.url (ticket), eventStatus, performer/organizer (niet gebruikt v1)
 */

export type ParsedJsonLdEvent = {
  uid: string;
  name: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date | null;
  imageUrl: string | null;
  ticketUrl: string | null;
  /** Schema.org eventStatus URL — gebruikt om cancelled events te skippen. */
  eventStatus: string | null;
  /** True als startDate `YYYY-MM-DD` was (geen tijd). Caller bepaalt wat
   *  voor default-tijd plausibel is voor de venue (club = avond, museum
   *  = ochtend, etc.). */
  isDateOnly: boolean;
  /** Performers/acts uit Schema.org `performer`/`performers`-velden.
   *  Wordt door de orchestrator als lineup-fallback gebruikt wanneer
   *  Claude geen lineup uit de description haalt. */
  performers: string[];
  /** Tijd-range gevonden in de HTML rond dit event-block (bv. Lofi:
   *  "14:00 – 05:00"). Alleen gevuld voor date-only events waar het
   *  surrounding script-block 1-op-1 bij dit event hoorde. Caller
   *  gebruikt dit om de venue-default-tijd te overrulen. */
  htmlStartTime: { hour: number; minute: number } | null;
  htmlEndTime: { hour: number; minute: number } | null;
};

const EVENT_TYPES = new Set([
  'Event',
  'ScreeningEvent',
  'MusicEvent',
  'TheaterEvent',
  'DanceEvent',
  'ComedyEvent',
  'EducationEvent',
  'ExhibitionEvent',
  'Festival',
  'LiteraryEvent',
  'SocialEvent',
  'VisualArtsEvent',
  'BusinessEvent',
  'FoodEvent',
  'SportsEvent',
]);

function isEventType(t: unknown): boolean {
  if (typeof t === 'string') return EVENT_TYPES.has(t);
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && EVENT_TYPES.has(x));
  return false;
}

/** Walk recursief door een JSON-LD waarde en yield elke @type:Event-achtige
 *  object. */
function* walkEvents(node: unknown): Generator<Record<string, unknown>> {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) yield* walkEvents(item);
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (isEventType(obj['@type'])) yield obj;
  // `@graph` is de standaard manier om meerdere root-nodes te bundelen.
  if (Array.isArray(obj['@graph'])) {
    for (const item of obj['@graph']) yield* walkEvents(item);
  }
  // Sommige sites nesten events in eigenaardige plekken; één laagje
  // dieper kijken voor 'event' / 'subEvent' / 'workPerformed' velden.
  for (const key of ['event', 'subEvent', 'subEvents']) {
    if (key in obj) yield* walkEvents(obj[key]);
  }
}

function pickImage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = pickImage(v);
      if (s) return s;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.contentUrl === 'string') return obj.contentUrl;
  }
  return null;
}

function pickTicketUrl(offers: unknown, fallback: string | null): string | null {
  if (!offers) return fallback;
  if (Array.isArray(offers)) {
    for (const o of offers) {
      const u = pickTicketUrl(o, null);
      if (u) return u;
    }
    return fallback;
  }
  if (typeof offers === 'object') {
    const obj = offers as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
  }
  return fallback;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

/** Decodeer veelvoorkomende HTML-entities (`&amp;`, `&#8211;`, `&#x2014;`).
 *  WordPress/JSON-LD-feeds laten deze regelmatig staan in titel-velden. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnlyString(value: unknown): boolean {
  return typeof value === 'string' && DATE_ONLY_RE.test(value);
}

/** Vind de eerste tijd-range "HH:MM – HH:MM" (en/dash/hyphen) in een
 *  blok HTML/text. Strip eerst HTML-tags zodat tags geen valse digits
 *  injecteren. Returnt null als geen plausibele range gevonden. */
function findTimeRangeInHtml(
  html: string
): {
  start: { hour: number; minute: number };
  end: { hour: number; minute: number };
} | null {
  // Decode entities (&#8211; → –) zodat de regex hyphen/en-dash ziet.
  const decoded = decodeHtmlEntities(html);
  // Vervang HTML-tags door spatie zodat "14:00<br />– 05:00" goed parsed.
  const text = decoded.replace(/<[^>]+>/g, ' ');
  const re = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/;
  const m = text.match(re);
  if (!m) return null;
  const h1 = parseInt(m[1], 10);
  const m1 = parseInt(m[2], 10);
  const h2 = parseInt(m[3], 10);
  const m2 = parseInt(m[4], 10);
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return {
    start: { hour: h1, minute: m1 },
    end: { hour: h2, minute: m2 },
  };
}

function extractPerformers(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(extractPerformers);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const name =
      typeof obj.name === 'string' ? decodeHtmlEntities(obj.name).trim() : '';
    if (!name) return [];
    // Sommige venues stoppen meerdere namen in één `name`-veld:
    // "Hot Since 82, Kim April, Ranger Trucco" → splitsen op komma/&.
    return name
      .split(/[,&]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function extractJsonLdEvents(html: string): ParsedJsonLdEvent[] {
  const events: ParsedJsonLdEvent[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  const seenUids = new Set<string>();

  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Sommige sites embedden JSON-LD met niet-geëscapete chars; voor
      // v1 negeren we die blocks i.p.v. fallback-parsing.
      continue;
    }

    // Pre-script HTML-window om een tijd-range te zoeken bij date-only
    // events. Pak ~3 kB vóór de `<script>`-tag — genoeg om Lofi's
    // foldout met "14:00 – 05:00" te dekken zonder events van een
    // vorige rij mee te slurpen.
    const scriptStart = match.index;
    const windowStart = Math.max(0, scriptStart - 3000);
    const surroundingHtml = html.slice(windowStart, scriptStart);
    // Verzamel events uit dit script eerst los, zodat we alleen
    // tijd-range toepassen als het script 1 event bevatte (anders
    // weten we niet bij welke event de range hoort).
    const scriptEvents: ParsedJsonLdEvent[] = [];

    for (const ev of walkEvents(parsed)) {
      const name =
        typeof ev.name === 'string' ? decodeHtmlEntities(ev.name).trim() : '';
      const startsAt = parseDate(ev.startDate);
      if (!name || !startsAt) continue;

      // eventStatus: skip cancelled.
      const eventStatus =
        typeof ev.eventStatus === 'string' ? ev.eventStatus : null;
      if (eventStatus && eventStatus.toLowerCase().includes('cancelled')) {
        continue;
      }

      const ticketUrl = pickTicketUrl(ev.offers, null);
      const eventUrl = typeof ev.url === 'string' ? ev.url : null;
      const description =
        typeof ev.description === 'string'
          ? decodeHtmlEntities(ev.description).trim() || null
          : null;
      const imageUrl = pickImage(ev.image);
      const endsAt = parseDate(ev.endDate);
      const isDateOnly =
        isDateOnlyString(ev.startDate) || isDateOnlyString(ev.endDate);
      const performers = [
        ...extractPerformers(ev.performer),
        ...extractPerformers(ev.performers),
      ];

      // Stable UID: eventUrl (permalink) > name+startDate.
      //
      // NIET ticketUrl: die is muteerbaar. Lofi wisselt per event van
      // ticket-provider (geen offer → sibforms-nieuwsbrief → bash.social
      // → weeztix) en kreeg bij elke wissel een nieuwe id, dus een
      // nieuw event náást het oude. Resultaat: 81 events waar 48 echte
      // shows staan. De ticket-URL is een attribuut van het event, geen
      // identiteit.
      //
      // startsAt blijft op volledige timestamp-granulariteit — date-only
      // events (Lofi, W139) parsen naar UTC-midnight en zijn dus per dag
      // stabiel, terwijl een bioscoop met 14:00 én 20:00 op dezelfde dag
      // twee losse events houdt.
      const uidSource = eventUrl ?? `${name}|${startsAt.toISOString()}`;
      if (seenUids.has(uidSource)) continue;
      seenUids.add(uidSource);

      scriptEvents.push({
        uid: uidSource,
        name,
        description,
        startsAt,
        endsAt,
        imageUrl,
        ticketUrl: ticketUrl ?? eventUrl,
        eventStatus,
        isDateOnly,
        performers,
        htmlStartTime: null,
        htmlEndTime: null,
      });
    }

    // Pas tijd-range alleen toe als dit script-block precies 1 event
    // bevatte — anders is onduidelijk bij welk event de range hoort.
    if (scriptEvents.length === 1 && scriptEvents[0].isDateOnly) {
      const range = findTimeRangeInHtml(surroundingHtml);
      if (range) {
        scriptEvents[0].htmlStartTime = range.start;
        scriptEvents[0].htmlEndTime = range.end;
      }
    }
    events.push(...scriptEvents);
  }
  return events;
}
