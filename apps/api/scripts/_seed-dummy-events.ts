// Seed een handvol dummy events in de aankomende dagen voor testing van
// de genre-filter. Verwijderbaar via PATCH `published:false` of DELETE.
// Run: ADMIN_API_KEY=… pnpm tsx apps/api/scripts/_seed-dummy-events.ts

const BASE = process.env.API_BASE ?? 'https://api.andreas.amsterdam';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('Missing ADMIN_API_KEY env');
  process.exit(1);
}

type EventDraft = {
  id: string;
  title: string;
  venueId: string;
  startsAt: string;
  endsAt?: string;
  description?: string;
  category: 'Muziek' | 'Theater' | 'Literatuur' | 'Film';
  genres: string[];
  priceCents: number | null;
  ticketUrl?: string;
};

// Lokale ISO met +02:00 (zomertijd Amsterdam in mei).
const at = (day: string, time: string) => `2026-05-${day}T${time}:00+02:00`;

const events: EventDraft[] = [
  {
    id: 'evt-dummy-kriterion-2026-05-05-past-lives',
    title: 'Past Lives — re-release',
    venueId: 'kriterion',
    startsAt: at('05', '19:30'),
    endsAt: at('05', '21:30'),
    description: 'Celine Songs debuut, weer op het grote doek.',
    category: 'Film',
    genres: ['arthouse'],
    priceCents: 1100,
  },
  {
    id: 'evt-dummy-paradiso-2026-05-05-caribou',
    title: 'Caribou — Honey Tour',
    venueId: 'paradiso',
    startsAt: at('05', '21:00'),
    endsAt: at('05', '23:30'),
    description: 'Dan Snaith komt langs met zijn warmste plaat tot nu toe.',
    category: 'Muziek',
    genres: ['electronic', 'indie'],
    priceCents: 3250,
  },
  {
    id: 'evt-dummy-cinetol-2026-05-06-stalker',
    title: 'Stalker — Tarkovsky',
    venueId: 'cinetol',
    startsAt: at('06', '20:00'),
    endsAt: at('06', '22:45'),
    description: 'Drie mannen, een zone, een hoop stilte.',
    category: 'Film',
    genres: ['arthouse', 'klassiek'],
    priceCents: 1000,
  },
  {
    id: 'evt-dummy-bourbon-2026-05-06-after-hours',
    title: 'After Hours Jazz Trio',
    venueId: 'bourbon-street',
    startsAt: at('06', '21:00'),
    endsAt: at('07', '01:00'),
    description: 'Kleine zaal, late set, doorgaans tot de laatste gast weg is.',
    category: 'Muziek',
    genres: ['jazz'],
    priceCents: 0,
  },
  {
    id: 'evt-dummy-melkweg-2026-05-06-yves-tumor',
    title: 'Yves Tumor',
    venueId: 'melkweg',
    startsAt: at('06', '22:00'),
    endsAt: at('07', '00:30'),
    description: 'Onaangepaste glam-rock-noise op de Max-stage.',
    category: 'Muziek',
    genres: ['indie', 'experimenteel'],
    priceCents: 2800,
  },
  {
    id: 'evt-dummy-frascati-2026-05-07-de-onzichtbare',
    title: 'De Onzichtbare',
    venueId: 'frascati',
    startsAt: at('07', '20:00'),
    endsAt: at('07', '21:30'),
    description: 'Solovoorstelling over verdwijnen in een drukke stad.',
    category: 'Theater',
    genres: ['drama'],
    priceCents: 1900,
  },
  {
    id: 'evt-dummy-bimhuis-2026-05-07-esperanza',
    title: 'Esperanza Spalding Quintet',
    venueId: 'bimhuis',
    startsAt: at('07', '20:30'),
    endsAt: at('07', '22:45'),
    description: 'Bassist-zangeres met een vijfkoppige groep.',
    category: 'Muziek',
    genres: ['jazz'],
    priceCents: 3800,
  },
  {
    id: 'evt-dummy-perdu-2026-05-07-slam',
    title: 'Slam Avond #14',
    venueId: 'perdu',
    startsAt: at('07', '20:00'),
    endsAt: at('07', '22:30'),
    description: 'Open mic met jury van vakgenoten.',
    category: 'Literatuur',
    genres: ['poëzie', 'slam'],
    priceCents: 800,
  },
  {
    id: 'evt-dummy-de-balie-2026-05-08-bregman',
    title: 'Lezing: Rutger Bregman',
    venueId: 'de-balie',
    startsAt: at('08', '20:00'),
    endsAt: at('08', '22:00'),
    description: 'Over moreel ambitieus zijn in een cynische tijd.',
    category: 'Literatuur',
    genres: ['lezing', 'essay'],
    priceCents: 1500,
  },
  {
    id: 'evt-dummy-occii-2026-05-08-brutalismus',
    title: 'Brutalismus 3000',
    venueId: 'occii',
    startsAt: at('08', '22:30'),
    endsAt: at('09', '03:00'),
    description: 'Berlijns duo dat techno terug naar 180bpm sleurt.',
    category: 'Muziek',
    genres: ['techno', 'gabber'],
    priceCents: 1800,
  },
  {
    id: 'evt-dummy-compagnietheater-2026-05-09-ne-bezet',
    title: 'Ne Bezet — Cabaret',
    venueId: 'compagnietheater',
    startsAt: at('09', '20:30'),
    endsAt: at('09', '22:00'),
    description: 'Vlaamse import met scherpe pen.',
    category: 'Theater',
    genres: ['cabaret'],
    priceCents: 2400,
  },
  {
    id: 'evt-dummy-radion-2026-05-09-helena-hauff',
    title: 'Helena Hauff — all night long',
    venueId: 'radion',
    startsAt: at('09', '23:30'),
    endsAt: at('10', '07:00'),
    description: 'Hardware, electro en geen genade.',
    category: 'Muziek',
    genres: ['techno', 'electronic'],
    priceCents: 2200,
  },
  {
    id: 'evt-dummy-bijlmer-parktheater-2026-05-10-de-wolf',
    title: 'De Wolf — Familievoorstelling',
    venueId: 'bijlmer-parktheater',
    startsAt: at('10', '16:00'),
    endsAt: at('10', '17:15'),
    description: 'Voor 6+. Schimmenspel met live muziek.',
    category: 'Theater',
    genres: ['kindertheater'],
    priceCents: 1200,
  },
];

async function postEvent(e: EventDraft) {
  const res = await fetch(`${BASE}/admin/api/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(e),
  });
  if (res.ok) {
    console.log(`✓ ${e.id}`);
    return;
  }
  const text = await res.text();
  // 409 = bestaat al — dan PATCH'en zodat genres + tijden updaten
  if (res.status === 409) {
    const patch = await fetch(`${BASE}/admin/api/events/${e.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(e),
    });
    if (patch.ok) {
      console.log(`↻ ${e.id} (patched)`);
      return;
    }
    console.error(`✗ ${e.id} — patch failed:`, patch.status, await patch.text());
    return;
  }
  console.error(`✗ ${e.id}:`, res.status, text);
}

async function main() {
  for (const e of events) {
    await postEvent(e);
  }
  console.log(`\nDone — ${events.length} events.`);
}

main();
