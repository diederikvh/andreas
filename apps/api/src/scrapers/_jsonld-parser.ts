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

      // Stable UID: voorkeur ticketUrl > eventUrl > name+startDate.
      // Behoudt idempotency over scrapes heen: dezelfde voorstelling
      // op dezelfde tijd produceert dezelfde id.
      const uidSource = ticketUrl ?? eventUrl ?? `${name}|${startsAt.toISOString()}`;
      if (seenUids.has(uidSource)) continue;
      seenUids.add(uidSource);

      events.push({
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
      });
    }
  }
  return events;
}
