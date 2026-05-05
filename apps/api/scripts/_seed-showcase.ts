/**
 * Showcase-seed: laat alle features van het event/occurrences-model
 * zien in de app. Niet voor productie — alleen om in TestFlight visueel
 * te kunnen testen of multi-occurrence, exhibition, series, sold_out,
 * en weekly feeds er goed uitzien.
 *
 * Idempotent: events met bestaande id worden geskipt. Bij re-run wordt
 * niets overschreven; verwijder de rijen handmatig om opnieuw te seeden.
 *
 *   pnpm tsx --env-file=.env scripts/_seed-showcase.ts
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

function dayAt(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function plusMin(d: Date, m: number): Date {
  const next = new Date(d);
  next.setMinutes(next.getMinutes() + m);
  return next;
}

type LineupEntry = { name: string; role?: 'dj' | 'support' | 'headliner' | 'act' };

type OccurrenceDraft = {
  startsAt: Date;
  endsAt: Date;
  priceCents: number | null;
  priceNote?: string | null;
  ticketUrl?: string | null;
  room?: string | null;
  lineup?: LineupEntry[] | null;
  status?: 'scheduled' | 'cancelled' | 'sold_out';
};

type EventDraft = {
  id: string;
  venueId: string;
  title: string;
  description: string;
  kind: 'show' | 'exhibition';
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film';
  imageUrl: string;
  genres: string[];
  featured?: boolean;
  occurrences: OccurrenceDraft[];
};

const IMG = {
  film: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1200&q=70&auto=format&fit=crop',
  theater: 'https://images.unsplash.com/photo-1503095396549-807759245b35?w=1200&q=70&auto=format&fit=crop',
  museum: 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=1200&q=70&auto=format&fit=crop',
  galerie: 'https://images.unsplash.com/photo-1577083552431-6e5fd01988ec?w=1200&q=70&auto=format&fit=crop',
  club: 'https://images.unsplash.com/photo-1571266028243-e1f1996c11df?w=1200&q=70&auto=format&fit=crop',
  concert: 'https://images.unsplash.com/photo-1501612780327-45045538702b?w=1200&q=70&auto=format&fit=crop',
  festival: 'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=1200&q=70&auto=format&fit=crop',
};

// ─── 1. Film met meerdere sessies (Anatomy of a Fall, Kriterion) ────────
const E1: EventDraft = {
  id: 'evt-show-anatomy-of-a-fall',
  venueId: 'kriterion',
  title: 'Anatomy of a Fall',
  description:
    'Justine Triet ontleedt een huwelijk via een rechtszaal. Sandra Hüller in haar beste rol tot nu toe — drie uur waarbij niemand op de telefoon kijkt.',
  kind: 'show',
  category: 'Film',
  imageUrl: IMG.film,
  genres: ['arthouse', 'drama'],
  featured: true,
  occurrences: [
    // vandaag 4×
    { startsAt: dayAt(0, 14, 0), endsAt: dayAt(0, 16, 30), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(0, 17, 0), endsAt: dayAt(0, 19, 30), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(0, 19, 30), endsAt: dayAt(0, 22, 0), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(0, 22, 0), endsAt: dayAt(1, 0, 30), priceCents: 1100, room: 'Zaal 2', ticketUrl: 'https://kriterion.nl/tickets' },
    // morgen 3×
    { startsAt: dayAt(1, 14, 0), endsAt: dayAt(1, 16, 30), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(1, 19, 30), endsAt: dayAt(1, 22, 0), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(1, 22, 0), endsAt: dayAt(2, 0, 30), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    // overmorgen 2×
    { startsAt: dayAt(2, 19, 30), endsAt: dayAt(2, 22, 0), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
    { startsAt: dayAt(2, 22, 0), endsAt: dayAt(3, 0, 30), priceCents: 1100, ticketUrl: 'https://kriterion.nl/tickets' },
  ],
};

// ─── 2. Theater-residency (Hamlet, Frascati) ───────────────────────────
const E2: EventDraft = {
  id: 'evt-show-hamlet-frascati',
  venueId: 'frascati',
  title: 'Hamlet — Toneelgroep Avontuur',
  description:
    'Een radicaal ingedikte Hamlet door Toneelgroep Avontuur. 90 minuten zonder pauze, geen requisieten, alleen taal en licht.',
  kind: 'show',
  category: 'Theater',
  imageUrl: IMG.theater,
  genres: ['drama'],
  occurrences: [
    { startsAt: dayAt(1, 20, 30), endsAt: dayAt(1, 22, 0), priceCents: 1850, room: 'Frascati 2', ticketUrl: 'https://frascati.nl/hamlet' },
    { startsAt: dayAt(2, 20, 30), endsAt: dayAt(2, 22, 0), priceCents: 1850, room: 'Frascati 2', ticketUrl: 'https://frascati.nl/hamlet' },
    { startsAt: dayAt(3, 20, 30), endsAt: dayAt(3, 22, 0), priceCents: 1850, room: 'Frascati 2', ticketUrl: 'https://frascati.nl/hamlet' },
    { startsAt: dayAt(7, 20, 30), endsAt: dayAt(7, 22, 0), priceCents: 1850, room: 'Frascati 4', ticketUrl: 'https://frascati.nl/hamlet' },
    { startsAt: dayAt(8, 20, 30), endsAt: dayAt(8, 22, 0), priceCents: 1850, room: 'Frascati 4', ticketUrl: 'https://frascati.nl/hamlet' },
    // laatste voorstelling sold_out — om de status-feature te laten zien
    { startsAt: dayAt(9, 20, 30), endsAt: dayAt(9, 22, 0), priceCents: 1850, room: 'Frascati 4', ticketUrl: 'https://frascati.nl/hamlet', status: 'sold_out' },
  ],
};

// ─── 3. Museum-tentoonstelling (Van Gogh Museum, kind=exhibition) ──────
const E3: EventDraft = {
  id: 'evt-show-vincent-auvers',
  venueId: 'van-gogh-museum',
  title: 'Vincent in Auvers-sur-Oise',
  description:
    'De laatste 70 dagen van Van Gogh. 50 schilderijen en tekeningen die hij maakte in Auvers, plus correspondentie en archiefmateriaal.',
  kind: 'exhibition',
  category: 'Theater',
  imageUrl: IMG.museum,
  genres: ['kunst', 'klassiek'],
  featured: true,
  occurrences: [
    // Eén lange occurrence: loopt van vandaag t/m ~3 maanden vooruit.
    {
      startsAt: dayAt(0, 9, 0),
      endsAt: dayAt(90, 18, 0),
      priceCents: 2200,
      priceNote: 'incl. museum-entree',
      ticketUrl: 'https://vangoghmuseum.nl/tickets',
    },
  ],
};

// ─── 4. Opening (W139) ────────────────────────────────────────────────
const E4: EventDraft = {
  id: 'evt-show-opening-sallam',
  venueId: 'w139',
  title: 'Opening: Sara Sallam — A Cathedral of Salt',
  description:
    'Solo-tentoonstelling van Sara Sallam — over wat blijft als landschappen verdwijnen. Met DJ-set van Esma Tanis na de toespraak.',
  kind: 'show',
  category: 'Theater',
  imageUrl: IMG.galerie,
  genres: ['kunst', 'opening'],
  featured: true,
  occurrences: [
    {
      startsAt: dayAt(2, 19, 0),
      endsAt: dayAt(2, 22, 30),
      priceCents: 0,
      priceNote: 'gratis · aanmelden gewenst',
      ticketUrl: 'https://w139.nl/opening',
      lineup: [
        { name: 'Sara Sallam', role: 'act' },
        { name: 'Mariëlle Hendriks (curator)', role: 'support' },
        { name: 'Esma Tanis', role: 'dj' },
      ],
    },
  ],
};

// Bonus-event: tentoonstelling van Sara die ook bij W139 blijft hangen
// na de opening — koppelt later via series met de opening.
const E4b: EventDraft = {
  id: 'evt-show-tentoonstelling-sallam',
  venueId: 'w139',
  title: 'Sara Sallam — A Cathedral of Salt',
  description:
    'Sara Sallam, Egyptisch-Nederlands, werkt met archiefmateriaal en zout om verlies tastbaar te maken. Drie zalen, twee video-installaties.',
  kind: 'exhibition',
  category: 'Theater',
  imageUrl: IMG.galerie,
  genres: ['kunst'],
  occurrences: [
    {
      startsAt: dayAt(2, 19, 0),
      endsAt: dayAt(38, 18, 0), // ~5 weken
      priceCents: 0,
      priceNote: 'gratis',
      ticketUrl: null,
    },
  ],
};

// ─── 5. Wekelijks feest (Garage Noord, kind=show, multi-occurrence) ────
const weeklyMonday = (weeksFromNow: number): Date => {
  const d = new Date();
  // vind eerstvolgende maandag
  const dayOfWeek = d.getDay(); // 0=zo, 1=ma
  const daysUntilMonday = ((1 - dayOfWeek + 7) % 7) || 7;
  d.setDate(d.getDate() + daysUntilMonday + weeksFromNow * 7);
  d.setHours(22, 0, 0, 0);
  return d;
};
const E5: EventDraft = {
  id: 'evt-show-de-maandag',
  venueId: 'garage-noord',
  title: 'De Maandag',
  description:
    'Maandagnacht-residency in de garage. Rauwe house, geen dresscode, einde wanneer de zon opkomt. Wisselende lineups — soms één DJ, soms vijf.',
  kind: 'show',
  category: 'Muziek',
  imageUrl: IMG.club,
  genres: ['house', 'techno'],
  occurrences: [
    {
      startsAt: weeklyMonday(0),
      endsAt: plusMin(weeklyMonday(0), 6 * 60),
      priceCents: 1500,
      ticketUrl: 'https://garagenoord.com/de-maandag',
      lineup: [
        { name: 'Mama Snake', role: 'headliner' },
        { name: 'Identified Patient', role: 'support' },
        { name: 'Esma Tanis', role: 'dj' },
      ],
    },
    {
      startsAt: weeklyMonday(1),
      endsAt: plusMin(weeklyMonday(1), 6 * 60),
      priceCents: 1500,
      ticketUrl: 'https://garagenoord.com/de-maandag',
      lineup: [
        { name: 'Carista', role: 'headliner' },
        { name: 'Job Sifre', role: 'support' },
      ],
    },
    {
      startsAt: weeklyMonday(2),
      endsAt: plusMin(weeklyMonday(2), 6 * 60),
      priceCents: 1500,
      ticketUrl: 'https://garagenoord.com/de-maandag',
      lineup: [
        { name: 'Upsammy', role: 'headliner' },
        { name: 'Sweely', role: 'support' },
        { name: 'Fawn', role: 'dj' },
      ],
    },
    {
      startsAt: weeklyMonday(3),
      endsAt: plusMin(weeklyMonday(3), 6 * 60),
      priceCents: 1500,
      ticketUrl: 'https://garagenoord.com/de-maandag',
      lineup: [
        { name: 'Octo Octa', role: 'headliner' },
        { name: 'Eris Drew', role: 'headliner' },
      ],
    },
    {
      startsAt: weeklyMonday(4),
      endsAt: plusMin(weeklyMonday(4), 6 * 60),
      priceCents: 1500,
      ticketUrl: 'https://garagenoord.com/de-maandag',
      lineup: [
        { name: 'Helena Hauff', role: 'headliner' },
      ],
    },
  ],
};

// ─── 6. Sold-out concert (Paradiso) ────────────────────────────────────
const E6: EventDraft = {
  id: 'evt-show-caribou-paradiso',
  venueId: 'paradiso',
  title: 'Caribou — Honey Tour',
  description:
    'Dan Snaith komt langs met zijn warmste plaat in jaren. Live-band setting, niet de DJ-set.',
  kind: 'show',
  category: 'Muziek',
  imageUrl: IMG.concert,
  genres: ['electronic', 'indie'],
  featured: true,
  occurrences: [
    {
      startsAt: dayAt(4, 21, 0),
      endsAt: dayAt(4, 23, 30),
      priceCents: 3250,
      ticketUrl: 'https://paradiso.nl/caribou',
      status: 'sold_out',
      lineup: [
        { name: 'Caribou', role: 'headliner' },
      ],
    },
  ],
};

// ─── 7. Drie-daags festival-blok (OT301) ───────────────────────────────
const E7: EventDraft = {
  id: 'evt-show-ot301-lab',
  venueId: 'ot301',
  title: 'OT301 Lab — driedaagse',
  description:
    'Drie nachten experiment in de OT301. Avond 1 = drone + ambient, avond 2 = noise + voice, avond 3 = club. Ticket geldig voor één avond of als passe-partout.',
  kind: 'show',
  category: 'Muziek',
  imageUrl: IMG.festival,
  genres: ['experimenteel', 'noise', 'ambient'],
  occurrences: [
    {
      startsAt: dayAt(5, 21, 0),
      endsAt: dayAt(6, 1, 0),
      priceCents: 1200,
      priceNote: 'avond 1 — drone & ambient',
      ticketUrl: 'https://ot301.nl/lab',
      room: 'Studio A',
      lineup: [
        { name: 'KMRU', role: 'headliner' },
        { name: 'Tomoko Sauvage', role: 'support' },
      ],
    },
    {
      startsAt: dayAt(6, 21, 0),
      endsAt: dayAt(7, 2, 0),
      priceCents: 1200,
      priceNote: 'avond 2 — noise & voice',
      ticketUrl: 'https://ot301.nl/lab',
      room: 'Studio A',
      lineup: [
        { name: 'Pharmakon', role: 'headliner' },
        { name: 'Lea Bertucci', role: 'support' },
      ],
    },
    {
      startsAt: dayAt(7, 22, 0),
      endsAt: dayAt(8, 5, 0),
      priceCents: 1500,
      priceNote: 'avond 3 — club',
      ticketUrl: 'https://ot301.nl/lab',
      room: 'Cinema',
      lineup: [
        { name: 'Aïsha Devi', role: 'headliner' },
        { name: 'Ziúr', role: 'support' },
        { name: 'rRoxymore', role: 'dj' },
      ],
    },
  ],
};

const EVENTS: EventDraft[] = [E1, E2, E3, E4, E4b, E5, E6, E7];

async function eventExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(eq(schema.events.id, id))
    .limit(1);
  return Boolean(row);
}

async function venueExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.venues.id })
    .from(schema.venues)
    .where(eq(schema.venues.id, id))
    .limit(1);
  return Boolean(row);
}

let createdEvents = 0;
let skippedEvents = 0;
let createdOccurrences = 0;
let missingVenues: string[] = [];

for (const evt of EVENTS) {
  if (await eventExists(evt.id)) {
    // eslint-disable-next-line no-console
    console.log(`↷ skip ${evt.id} (bestaat al)`);
    skippedEvents++;
    continue;
  }
  if (!(await venueExists(evt.venueId))) {
    // eslint-disable-next-line no-console
    console.warn(`✗ venue ${evt.venueId} niet gevonden — skip ${evt.id}`);
    missingVenues.push(`${evt.id} → ${evt.venueId}`);
    continue;
  }

  await db.transaction(async (tx) => {
    await tx.insert(schema.events).values({
      id: evt.id,
      venueId: evt.venueId,
      title: evt.title,
      description: evt.description,
      kind: evt.kind,
      category: evt.category,
      imageUrl: evt.imageUrl,
      genres: evt.genres,
      featured: evt.featured ?? false,
      published: true,
    });

    const occRows = evt.occurrences.map((o, i) => ({
      id: `occ-${evt.id}-${i + 1}`,
      eventId: evt.id,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      priceCents: o.priceCents,
      priceNote: o.priceNote ?? null,
      ticketUrl: o.ticketUrl ?? null,
      room: o.room ?? null,
      lineup: o.lineup ?? null,
      status: o.status ?? 'scheduled',
    }));
    await tx.insert(schema.occurrences).values(occRows);
    createdOccurrences += occRows.length;
  });

  // eslint-disable-next-line no-console
  console.log(`✓ ${evt.id} — ${evt.occurrences.length} moment(en)`);
  createdEvents++;
}

// Series: koppel opening + tentoonstelling van Sara Sallam ───────────
const SERIES_ID = 'series-sara-sallam-cathedral';
const seriesExists = async (id: string): Promise<boolean> => {
  const [row] = await db
    .select({ id: schema.series.id })
    .from(schema.series)
    .where(eq(schema.series.id, id))
    .limit(1);
  return Boolean(row);
};

if (!(await seriesExists(SERIES_ID))) {
  const e3Exists = await eventExists(E4.id);
  const e4bExists = await eventExists(E4b.id);
  if (e3Exists && e4bExists) {
    await db.insert(schema.series).values({
      id: SERIES_ID,
      slug: 'sara-sallam-cathedral',
      name: 'Sara Sallam — A Cathedral of Salt',
      description:
        'Solo-tentoonstelling met opening, sluitingsavond en artist talk halverwege.',
      imageUrl: IMG.galerie,
      startsAt: dayAt(2, 19, 0),
      endsAt: dayAt(38, 18, 0),
      categories: ['Theater'],
      published: true,
    });
    await db.insert(schema.eventsInSeries).values([
      { seriesId: SERIES_ID, eventId: E4.id },
      { seriesId: SERIES_ID, eventId: E4b.id },
    ]);
    // eslint-disable-next-line no-console
    console.log(`✓ ${SERIES_ID} — opening + tentoonstelling gekoppeld`);
  }
} else {
  // eslint-disable-next-line no-console
  console.log(`↷ skip series ${SERIES_ID} (bestaat al)`);
}

// eslint-disable-next-line no-console
console.log(
  `\nDone — ${createdEvents} events aangemaakt (${createdOccurrences} occurrences), ${skippedEvents} skipped, ${missingVenues.length} venue-misses.`
);
if (missingVenues.length > 0) {
  // eslint-disable-next-line no-console
  console.log('Missende venues:');
  for (const m of missingVenues) console.log(`  ${m}`);
}
process.exit(0);
