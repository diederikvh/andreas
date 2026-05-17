/**
 * Verwijder EN-duplicate-events bij Het Concertgebouw.
 *
 * Strategie:
 *  1. Vind alle pairs op zelfde startsAt + venue
 *  2. Score elke titel op NL- vs EN-keywords
 *  3. Als de scores duidelijk verschillen EN de title-similarity hoog
 *     is → EN-versie verwijderen
 *  4. Skip pairs waar het niet duidelijk is (parallel-zaal-shows,
 *     gelijke scores)
 *
 * Dry-run default. Pass `--apply` om echt te deleten.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';

const NL_MARKERS = [
  ' van ', ' met ', ' en ', ' door ', ' bij ', ' tot ', ' naar ',
  ' speelt ', ' spelen ', ' dirigeert ', ' eerbetoon ', ' jaargetijden',
  ' orkest', ' pianoconcert', ' vioolconcert', ' kwartet',
  ' aanstormend', ' debut',
  'sjostakovitsj', 'tsjaikovski', 'concertgebouworkest',
];
const EN_MARKERS = [
  ' by ', ' and ', ' with ', ' for ', ' to ', ' from ',
  ' plays ', ' conducts ', ' opera house', ' tribute',
  ' four seasons', ' quartet', ' orchestra', ' songs',
  ' chamber orchestra', ' violin concerto', ' piano concerto',
  'shostakovich', 'tchaikovsky',
];

function score(title: string, markers: string[]): number {
  const t = ' ' + title.toLowerCase() + ' ';
  return markers.reduce((s, m) => s + (t.includes(m) ? 1 : 0), 0);
}

function words(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/\W+/).filter((w) => w.length > 3)
  );
}

function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const intersect = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return intersect / union;
}

const apply = process.argv.includes('--apply');

const rows = await db
  .select({
    id: schema.events.id,
    title: schema.events.title,
    startsAt: schema.occurrences.startsAt,
  })
  .from(schema.events)
  .innerJoin(schema.occurrences, eq(schema.occurrences.eventId, schema.events.id))
  .where(eq(schema.events.venueId, 'het-concertgebouw'));

// Groepeer per startsAt
const groups = new Map<string, { id: string; title: string }[]>();
for (const r of rows) {
  const key = r.startsAt.toISOString();
  const arr = groups.get(key) ?? [];
  arr.push({ id: r.id, title: r.title });
  groups.set(key, arr);
}

const toDelete: Array<{ id: string; title: string; nlTitle: string; sim: number; nlScore: number; enScore: number }> = [];
const skipped: Array<{ startsAt: string; a: string; b: string; sim: number; reason: string }> = [];

for (const [startsAt, items] of groups) {
  if (items.length < 2) continue;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const sim = similarity(a.title, b.title);
      if (sim < 0.3) {
        skipped.push({ startsAt, a: a.title, b: b.title, sim, reason: 'low-similarity' });
        continue;
      }
      const nlA = score(a.title, NL_MARKERS);
      const enA = score(a.title, EN_MARKERS);
      const nlB = score(b.title, NL_MARKERS);
      const enB = score(b.title, EN_MARKERS);
      const aLeanNl = nlA > enA;
      const bLeanNl = nlB > enB;
      if (aLeanNl && !bLeanNl) {
        toDelete.push({ id: b.id, title: b.title, nlTitle: a.title, sim, nlScore: nlA, enScore: enB });
      } else if (bLeanNl && !aLeanNl) {
        toDelete.push({ id: a.id, title: a.title, nlTitle: b.title, sim, nlScore: nlB, enScore: enA });
      } else {
        skipped.push({ startsAt, a: a.title, b: b.title, sim,
          reason: `unclear: nlA=${nlA} enA=${enA} nlB=${nlB} enB=${enB}` });
      }
    }
  }
}

console.log(`\n== TE VERWIJDEREN (EN-versie) — ${toDelete.length} ==`);
for (const d of toDelete) {
  console.log(`  sim=${d.sim.toFixed(2)} nl=${d.nlScore} en=${d.enScore}`);
  console.log(`    DELETE EN: ${d.title.slice(0, 80)}  (id=${d.id})`);
  console.log(`    KEEP   NL: ${d.nlTitle.slice(0, 80)}`);
}

console.log(`\n== SKIPPED (geen duidelijke dupe) — ${skipped.length} ==`);
for (const s of skipped.slice(0, 30)) {
  console.log(`  sim=${s.sim.toFixed(2)} [${s.reason}]`);
  console.log(`    A: ${s.a.slice(0, 70)}`);
  console.log(`    B: ${s.b.slice(0, 70)}`);
}

if (apply) {
  if (toDelete.length === 0) {
    console.log('\nNiets te verwijderen.');
  } else {
    const ids = toDelete.map((d) => d.id);
    const deleted = await db
      .delete(schema.events)
      .where(inArray(schema.events.id, ids))
      .returning({ id: schema.events.id });
    console.log(`\nDELETED ${deleted.length} events.`);
  }
} else {
  console.log('\n(dry-run — niets verwijderd. Pass --apply om echt te deleten.)');
}

process.exit(0);
