import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * De titelregels draaien in Postgres, dus deze test ook. Zonder echte
 * database (de test-dummy) slaat hij over.
 */
const live = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL!.includes('localhost/test');

test('artiest in de titel: optredens en tributes wel, naamgenoten niet', { skip: !live }, async () => {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index.js');
  const { titleHasName, titleTributeOf } = await import('./match.js');
  const cases: [string, string, 'optreden' | 'tribute' | 'niets'][] = [
    ['Madness', 'Wanderwelle performs A Page of Madness', 'niets'],
    ['Palace', 'Future Palace', 'niets'],
    ['Palace', 'Caravan Palace', 'niets'],
    ['Prince', "Bonnie 'Prince' Billy", 'niets'],
    ['Guru', 'Nederlands Blazers Ensemble- Raga & Rasa - van guru tot shishya', 'niets'],
    ['Jack Johnson', 'Jack & Jack', 'niets'],
    ['The Afghan Whigs', 'KINK presents Come As You Are 2026: The Afghan Whigs, shame, Republica & meer', 'optreden'],
    ['Angine de Poitrine', 'Angine De Poitrine (CAN) + Gros Mené (CAN)', 'optreden'],
    ['Jon Allen', 'JON ALLEN & THE LUNA KINGS', 'optreden'],
    ['Het Goede Doel', 'HET GOEDE DOEL®', 'optreden'],
    ['Alison Moyet', 'Alison Moyet - Songs of Yazoo, the minutes & Other', 'optreden'],
    ['Yazoo', 'Alison Moyet - Songs of Yazoo, the minutes & Other', 'tribute'],
    ['Fleetwood Mac', 'Rumours of Fleetwood Mac', 'tribute'],
    ['Fleetwood Mac', 'Blackbird & Emmely de Wilt — Fleetwood Mac: 50 jaar Rumours', 'tribute'],
    ['Simon & Garfunkel', 'The Music of Simon & Garfunkel', 'tribute'],
    ['Simon & Garfunkel', 'Niels van der Gulik en Frank Kooijman Simon & Garfunkel on Tour', 'tribute'],
    ['Prince', 'New Purple Celebration: The Music of Prince', 'tribute'],
    ['David Bowie', 'Station to Station – David Bowie Tribute', 'tribute'],
    ['Adele', 'Adele Tribute', 'tribute'],
  ];
  const rows = sql.join(cases.map(([n, t]) => sql`(${n}::text, ${t}::text)`), sql`, `);
  const res = await db.execute<{ n: string; t: string; perf: boolean; trib: boolean }>(sql`
    SELECT n, t, ${sql.raw(titleHasName('n', 't'))} AS perf, ${sql.raw(titleTributeOf('n', 't'))} AS trib
    FROM (VALUES ${rows}) AS c(n, t)`);
  // Een tribute is ook een treffer (`titleHasName`), met het label erbij.
  const got = res.rows.map((r) => [r.n, r.t, r.trib && r.perf ? 'tribute' : r.perf ? 'optreden' : 'niets']);
  assert.deepEqual(got, cases);
});
