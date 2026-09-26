/**
 * Unit tests voor de tijd-vensters. Run met:
 *   pnpm --filter @andreas/api test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PreferenceProfile } from './types.js';
import { EMPTY_PROFILE } from './types.js';

import { resolveWhenWindow } from './retrieval-core.js';

function profile(over: Partial<PreferenceProfile> = {}): PreferenceProfile {
  return { ...EMPTY_PROFILE, ...over };
}

test('resolveWhenWindow tonight: tot eerstvolgende 06:00 NL', () => {
  // Dinsdag 16 jun 2026, 21:00 NL = 19:00 UTC (zomertijd, UTC+2).
  const now = new Date('2026-06-16T19:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'tonight' }), now);
  assert.equal(from.getTime(), now.getTime());
  // 06:00 NL op 17 jun = 04:00 UTC.
  assert.equal(to.toISOString(), '2026-06-17T04:00:00.000Z');
});

test('resolveWhenWindow tonight na middernacht: hoort bij avond ervoor', () => {
  // Woensdag 17 jun 03:00 NL = 01:00 UTC. Logische dag = di 16 jun → to = 17 jun 06:00 NL.
  const now = new Date('2026-06-17T01:00:00Z');
  const { to } = resolveWhenWindow(profile({ when: 'tonight' }), now);
  assert.equal(to.toISOString(), '2026-06-17T04:00:00.000Z');
});

test('resolveWhenWindow specific: 06:00 → +24u', () => {
  const { from, to } = resolveWhenWindow(
    profile({ when: 'specific', whenDate: '2026-06-20' }),
    new Date('2026-06-16T12:00:00Z')
  );
  // 06:00 NL (zomertijd) = 04:00 UTC.
  assert.equal(from.toISOString(), '2026-06-20T04:00:00.000Z');
  assert.equal(to.toISOString(), '2026-06-21T04:00:00.000Z');
});

test('resolveWhenWindow this_week: nu → +7 dagen 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // di 16 jun 12:00 NL
  const { from, to } = resolveWhenWindow(profile({ when: 'this_week' }), now);
  assert.equal(from.getTime(), now.getTime());
  // logische dag = di 16 jun 06:00; +7 = di 23 jun 06:00 NL = 04:00 UTC.
  assert.equal(to.toISOString(), '2026-06-23T04:00:00.000Z');
});

test('resolveWhenWindow next_week: komende maandag → maandag erna (06:00 NL)', () => {
  // Dinsdag 16 jun 2026, 12:00 NL. Deze week = ma 15 jun; volgende week = ma 22 jun.
  const now = new Date('2026-06-16T10:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'next_week' }), now);
  assert.equal(from.toISOString(), '2026-06-22T04:00:00.000Z'); // ma 22 jun 06:00 NL
  assert.equal(to.toISOString(), '2026-06-29T04:00:00.000Z'); // ma 29 jun 06:00 NL
});

test('resolveWhenWindow next_week begint ná deze week (geen overlap met nu)', () => {
  const now = new Date('2026-06-16T10:00:00Z');
  const thisW = resolveWhenWindow(profile({ when: 'this_week' }), now);
  const nextW = resolveWhenWindow(profile({ when: 'next_week' }), now);
  assert.ok(nextW.from.getTime() >= thisW.to.getTime() - 24 * 3600 * 1000);
  assert.ok(nextW.from.getTime() > now.getTime());
});

test('resolveWhenWindow next_weekend: vr ná dit weekend', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // di 16 jun
  const { from, to } = resolveWhenWindow(profile({ when: 'next_weekend' }), now);
  // dit weekend = vr 19; volgend = vr 26 jun 18:00 → ma 29 jun 06:00.
  assert.equal(from.toISOString(), '2026-06-26T16:00:00.000Z'); // vr 26 jun 18:00 NL
  assert.equal(to.toISOString(), '2026-06-29T04:00:00.000Z'); // ma 29 jun 06:00 NL
});

test('resolveWhenWindow this_month: nu → 1e volgende maand 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // juni
  const { from, to } = resolveWhenWindow(profile({ when: 'this_month' }), now);
  assert.equal(from.getTime(), now.getTime());
  assert.equal(to.toISOString(), '2026-07-01T04:00:00.000Z'); // 1 jul 06:00 NL
});

test('resolveWhenWindow this_month: december rolt naar januari', () => {
  const now = new Date('2026-12-10T12:00:00Z'); // dec 13:00 NL (wintertijd UTC+1)
  const { to } = resolveWhenWindow(profile({ when: 'this_month' }), now);
  assert.equal(to.toISOString(), '2027-01-01T05:00:00.000Z'); // 1 jan 06:00 NL = 05:00 UTC
});

test('resolveWhenWindow this_year: nu → 1 jan volgend jaar 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z');
  const { to } = resolveWhenWindow(profile({ when: 'this_year' }), now);
  assert.equal(to.toISOString(), '2027-01-01T05:00:00.000Z');
});

test('resolveWhenWindow this_weekend: vr 18:00 → ma 06:00 NL', () => {
  // Dinsdag 16 jun → komende vrijdag = 19 jun.
  const now = new Date('2026-06-16T10:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'this_weekend' }), now);
  assert.equal(from.toISOString(), '2026-06-19T16:00:00.000Z'); // vr 18:00 NL
  assert.equal(to.toISOString(), '2026-06-22T04:00:00.000Z'); // ma 06:00 NL
});
