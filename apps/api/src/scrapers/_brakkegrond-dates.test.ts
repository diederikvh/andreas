import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTicketSlots, type Slot } from './_brakkegrond-dates.js';

/** Wall-time in Amsterdam, zodat een test niet afhangt van de tz van de
    machine die 'm draait. */
const wall = (d: Date) =>
  new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);

// Alle invoer hieronder is letterlijk van brakkegrond.nl geplukt.

test('losse datum zonder tijd → één slot om middernacht', () => {
  const s = parseTicketSlots("vr 18 sep '26", 'de Brakke Grond Gratis toegang.');
  assert.equal(s.length, 1);
  assert.equal(wall(s[0]!.startsAt), '18-09-2026, 00:00');
  assert.equal(s[0]!.endsAt, null);
});

test('reeks mét tijd → één slot per speeldag', () => {
  const s = parseTicketSlots("wo 21 okt '26—do 22 okt '26", 'Grote zaal 20:00 uur');
  assert.equal(s.length, 2);
  assert.equal(wall(s[0]!.startsAt), '21-10-2026, 20:00');
  assert.equal(wall(s[1]!.startsAt), '22-10-2026, 20:00');
});

test('reeks zonder tijd → één doorlopend slot, niet per dag', () => {
  const s = parseTicketSlots("vr 16 okt '26—zo 18 okt '26", 'de Brakke Grond');
  assert.equal(s.length, 1);
  assert.equal(wall(s[0]!.startsAt), '16-10-2026, 00:00');
  assert.equal(wall(s[0]!.endsAt!), '18-10-2026, 23:59');
});

test('expositie van drie maanden blijft één rij', () => {
  const s = parseTicketSlots("wo 14 apr '27—zo 18 jul '27", 'de Brakke Grond');
  assert.equal(s.length, 1);
});

test('komma is een lijst losse datums, geen reeks', () => {
  const s = parseTicketSlots("vr 18 sep '26,zo 25 okt '26", 'de Brakke Grond');
  assert.equal(s.length, 2);
  assert.equal(wall(s[0]!.startsAt), '18-09-2026, 00:00');
  assert.equal(wall(s[1]!.startsAt), '25-10-2026, 00:00');
});

test('winterdatum staat op CET, niet op de oude hardgecodeerde +02:00', () => {
  const s = parseTicketSlots("di 01 dec '26—wo 02 dec '26", 'Grote zaal 20:00');
  assert.equal(s.length, 2);
  assert.equal(wall(s[0]!.startsAt), '01-12-2026, 20:00');
  // 20:00 CET = 19:00 UTC. Met de oude +02:00 was dit 18:00 UTC geweest.
  assert.equal(s[0]!.startsAt.toISOString(), '2026-12-01T19:00:00.000Z');
});

test('reeks over de klokwissel houdt elke avond op 20:00 lokaal', () => {
  // Zomertijd eindigt zondag 25 okt 2026.
  const s = parseTicketSlots("vr 23 okt '26—wo 28 okt '26", 'Grote zaal 20:00 uur');
  assert.equal(s.length, 6);
  assert.deepEqual(s.map((x: Slot) => wall(x.startsAt)), [
    '23-10-2026, 20:00', '24-10-2026, 20:00', '25-10-2026, 20:00',
    '26-10-2026, 20:00', '27-10-2026, 20:00', '28-10-2026, 20:00',
  ]);
  // Voor de wissel +02:00, erna +01:00 — dus een ander UTC-uur.
  assert.equal(s[0]!.startsAt.toISOString(), '2026-10-23T18:00:00.000Z');
  assert.equal(s[5]!.startsAt.toISOString(), '2026-10-28T19:00:00.000Z');
});

test('onzin levert geen slots op in plaats van een NaN-datum', () => {
  assert.deepEqual(parseTicketSlots('binnenkort', 'Grote zaal'), []);
});
