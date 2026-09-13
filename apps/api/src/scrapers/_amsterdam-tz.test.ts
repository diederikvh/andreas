import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAmsterdamLocal, parseIsoFlexible } from './_amsterdam-tz.js';

/** Deze helper draagt sinds 13 sep 2026 de datumbouw van 23 scrapers.
    Daarvoor rekenden die zelf met een harde +02:00 of met een
    maandbereik (maart t/m oktober), en dat zit er bij een kwart van het
    jaar een uur naast. */

test('zomertijd: 20:00 in Amsterdam is 18:00 UTC', () => {
  assert.equal(parseAmsterdamLocal('2026-07-01T20:00:00').toISOString(), '2026-07-01T18:00:00.000Z');
});

test('wintertijd: 20:00 in Amsterdam is 19:00 UTC', () => {
  assert.equal(parseAmsterdamLocal('2026-12-01T20:00:00').toISOString(), '2026-12-01T19:00:00.000Z');
});

test('begin maart valt nog in wintertijd', () => {
  // De oude maand-check (>= 3) zette heel maart op +02:00. Zomertijd
  // begint pas de laatste zondag van maart: 29 maart 2026.
  assert.equal(parseAmsterdamLocal('2026-03-05T20:00:00').toISOString(), '2026-03-05T19:00:00.000Z');
  assert.equal(parseAmsterdamLocal('2026-03-30T20:00:00').toISOString(), '2026-03-30T18:00:00.000Z');
});

test('eind oktober valt al in wintertijd', () => {
  // De oude check (<= 10) hield heel oktober op +02:00. Zomertijd
  // eindigt de laatste zondag: 25 oktober 2026.
  assert.equal(parseAmsterdamLocal('2026-10-24T20:00:00').toISOString(), '2026-10-24T18:00:00.000Z');
  assert.equal(parseAmsterdamLocal('2026-10-26T20:00:00').toISOString(), '2026-10-26T19:00:00.000Z');
});

test('werkt ook met een spatie in plaats van een T, en zonder seconden', () => {
  assert.equal(parseAmsterdamLocal('2026-12-01 20:00').toISOString(), '2026-12-01T19:00:00.000Z');
});

test('onzin geeft een ongeldige datum in plaats van een verkeerde', () => {
  assert.ok(Number.isNaN(parseAmsterdamLocal(null).getTime()));
  assert.ok(Number.isNaN(parseAmsterdamLocal('').getTime()));
});

test('parseIsoFlexible vertrouwt een expliciete offset', () => {
  assert.equal(parseIsoFlexible('2026-12-01T20:00:00Z').toISOString(), '2026-12-01T20:00:00.000Z');
  assert.equal(parseIsoFlexible('2026-12-01T20:00:00+01:00').toISOString(), '2026-12-01T19:00:00.000Z');
});

test('parseIsoFlexible behandelt een kale string als Amsterdam-lokaal', () => {
  assert.equal(parseIsoFlexible('2026-12-01T20:00:00').toISOString(), '2026-12-01T19:00:00.000Z');
});
