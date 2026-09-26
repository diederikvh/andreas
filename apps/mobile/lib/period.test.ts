/**
 * Periodes van de gids. Draaien: `pnpm --filter @andreas/mobile test`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { periodOf } from './period.ts';

const sat = new Date(2026, 8, 26, 20); // za 26 sep, 20:00

test('vanavond en dit weekend op zaterdagavond', () => {
  assert.deepEqual(periodOf('tonight', sat), { from: '2026-09-26', to: '2026-09-26' });
  assert.deepEqual(periodOf('weekend', sat), { from: '2026-09-26', to: '2026-09-27' });
});

test('dit weekend midden in de week: vrijdag t/m zondag', () => {
  assert.deepEqual(periodOf('weekend', new Date(2026, 8, 30, 12)), { from: '2026-10-02', to: '2026-10-04' });
});

test('vóór 06:00 hoort bij gisteravond', () => {
  assert.deepEqual(periodOf('tonight', new Date(2026, 8, 27, 3)), { from: '2026-09-26', to: '2026-09-26' });
});

test('week, maand en alles', () => {
  assert.deepEqual(periodOf('week', sat), { from: '2026-09-26', to: '2026-10-02' });
  assert.deepEqual(periodOf('month', sat), { from: '2026-09-26', to: '2026-09-30' });
  assert.deepEqual(periodOf('any', sat), {});
});
