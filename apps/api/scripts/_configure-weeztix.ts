import { eq, ilike, or } from 'drizzle-orm';

import { db, schema } from '../src/db/index.js';

type Cfg = { id: string; shopUuid: string; imageAgendaUrl?: string };

const configs: Cfg[] = [
  {
    id: 'tilla-tec',
    shopUuid: '0e536f93-e4fd-11ee-a9cb-7e126431635e',
    imageAgendaUrl: 'https://www.tillatec.com/eventoverview',
  },
  {
    id: 'radio-radio',
    shopUuid: 'c5059b47-717d-11ed-aa54-6a57c78572ab',
    imageAgendaUrl: 'https://radioradio.radio/club',
  },
  {
    id: 'warehouse-elementenstraat',
    // discovered via probe of elementenstraat.nl/events
    shopUuid: '', // wordt straks gevuld
  },
];

// Find Warehouse Elementenstraat shop UUID via /events page
async function findElementenstraatUuid(): Promise<string | null> {
  const r = await fetch('https://elementenstraat.nl/events', { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/shop\.weeztix\.com\/([a-f0-9-]{36})/);
  return m?.[1] ?? null;
}

const wsUuid = await findElementenstraatUuid();
if (wsUuid) {
  configs[2].shopUuid = wsUuid;
  console.log(`  found Warehouse Elementenstraat UUID: ${wsUuid}`);
} else {
  console.log('  ! Warehouse Elementenstraat UUID niet gevonden');
}

const ids = configs.filter((c) => c.shopUuid).map((c) => c.id);
const dbVenues = await db
  .select({ id: schema.venues.id, name: schema.venues.name, scraperConfig: schema.venues.scraperConfig })
  .from(schema.venues)
  .where(or(...ids.map((id) => eq(schema.venues.id, id)), ilike(schema.venues.id, '%warehouse%'), ilike(schema.venues.id, '%elementen%')));
for (const v of dbVenues) console.log(`  found in DB: ${v.id} | ${v.name}`);

for (const c of configs) {
  if (!c.shopUuid) continue;
  const venue = dbVenues.find((v) => v.id === c.id) ?? dbVenues.find((v) => /warehouse|elementen/i.test(v.name) && c.id.includes('warehouse'));
  if (!venue) {
    console.log(`  ! ${c.id} niet in DB (skip)`);
    continue;
  }
  const next = {
    ...(venue.scraperConfig ?? {}),
    weeztix: {
      shopUuid: c.shopUuid,
      ...(c.imageAgendaUrl ? { imageAgendaUrl: c.imageAgendaUrl } : {}),
    },
  };
  await db.update(schema.venues).set({ scraperConfig: next }).where(eq(schema.venues.id, venue.id));
  console.log(`  + ${venue.id} → weeztix(${c.shopUuid.slice(0, 8)}...) gezet`);
}
process.exit(0);
