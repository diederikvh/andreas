/**
 * Weging en drempels van de event-match. Draaien:
 * `pnpm --filter @andreas/mobile test`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyMemory,
  learnFromPick,
  matchEvent,
  scoreCandidate,
  textScore,
} from './importMatch.ts';
import type { MatchCandidate } from './importMatch.ts';
import type { EventMetadata } from './importPayload.ts';

/** Het concept zoals fase 3 het van de testposter haalde. */
const DRAFT: EventMetadata = {
  title: 'PLOEGENDIENST',
  artists: ['PLOEGENDIENST', 'Library Card'],
  venue: 'Paradiso',
  date: '2026-10-18',
  time: '20:30',
  city: 'Amsterdam',
};

function candidate(
  over: Partial<MatchCandidate> & { id: string }
): MatchCandidate {
  return {
    title: 'Ploegendienst',
    venueName: 'Paradiso',
    startsAt: '2026-10-18T20:30:00+02:00',
    ...over,
  };
}

test('de juiste avond op de juiste plek → hoge confidence', () => {
  const result = matchEvent(DRAFT, [candidate({ id: 'a' })]);
  assert.equal(result.level, 'high');
  assert.equal(result.ranked[0].candidate.id, 'a');
  assert.equal(result.ranked[0].dateMatches, true);
  assert.ok(result.ranked[0].score > 0.95);
});

test('juiste event, andere datum → vragen, niet voorstellen', () => {
  // Precies het geval dat `/search` niet kan onderscheiden: een wekelijks
  // feest of een film met dertig voorstellingen, waarvan we alleen de
  // eerstvolgende datum zien.
  const result = matchEvent(DRAFT, [
    candidate({ id: 'a', startsAt: '2026-09-20T20:30:00+02:00' }),
  ]);
  assert.equal(result.level, 'medium');
  assert.equal(result.ranked[0].dateMatches, false);
});

test('titel matcht maar venue niet → nog steeds vragen', () => {
  const result = matchEvent(DRAFT, [
    candidate({ id: 'a', venueName: 'Melkweg' }),
  ]);
  assert.equal(result.level, 'medium');
});

test('twee even goede kandidaten → vragen in plaats van gokken', () => {
  const result = matchEvent(DRAFT, [
    candidate({ id: 'a' }),
    candidate({ id: 'b', title: 'Ploegendienst' }),
  ]);
  assert.equal(result.level, 'medium');
  assert.equal(result.ranked.length, 2);
});

test('niets dat erop lijkt → low', () => {
  const result = matchEvent(DRAFT, [
    candidate({ id: 'a', title: 'Kamerorkest Zuid', venueName: 'Bimhuis' }),
  ]);
  assert.equal(result.level, 'low');
});

test('geen kandidaten → low, geen crash', () => {
  assert.equal(matchEvent(DRAFT, []).level, 'low');
});

test('de artiestennaam mag matchen als de eventtitel anders heet', () => {
  const result = matchEvent(DRAFT, [
    candidate({ id: 'a', title: 'Library Card' }),
  ]);
  // Titel matcht via artists[1]; datum en venue kloppen.
  assert.equal(result.level, 'high');
});

test('ontbrekende tijd verdwijnt uit de noemer, telt niet als nul', () => {
  const zonderTijd = { ...DRAFT, time: null };
  const scored = scoreCandidate(zonderTijd, candidate({ id: 'a' }));
  assert.equal(scored.parts.time, null);
  assert.ok(scored.score > 0.95, `score was ${scored.score}`);
});

test('een club die om 01:00 begint hoort bij de avond ervoor', () => {
  const result = matchEvent(
    { ...DRAFT, time: '01:00' },
    [candidate({ id: 'a', startsAt: '2026-10-19T01:00:00+02:00' })]
  );
  assert.equal(result.ranked[0].dateMatches, true);
  assert.equal(result.level, 'high');
});

test('textScore', () => {
  assert.equal(textScore('Paradiso', 'paradiso'), 1);
  assert.equal(textScore('PLOEGENDIENST', 'Ploegendienst + support'), 0.9);
  assert.equal(textScore('', 'iets'), 0);
  assert.ok(textScore('Kamerorkest Zuid', 'Ploegendienst') < 0.2);
});

/* ── Zonder titel, en wat we van een handmatige koppeling leren ──────── */

/** Het kaartje van De Roma: de grootste regel is het logo van de zaal,
    niet de naam van wat je gaat zien. Zo kwam het binnen op 12 sep 2026. */
const TICKET: EventMetadata = {
  title: 'Bma',
  artists: [],
  venue: null,
  date: '2026-10-18',
  time: '20:30',
  city: null,
};

test('een leesfout als titel haalt niks op', () => {
  const result = matchEvent(TICKET, [candidate({ id: 'a' })]);
  assert.equal(result.level, 'low');
});

test('wat we leren van een koppeling: die regel is de zaal', () => {
  const lesson = learnFromPick(TICKET, candidate({ id: 'a' }));
  assert.deepEqual(lesson, { key: 'bma', venue: 'Paradiso' });
});

test('klopte de titel gewoon, dan valt er niets te leren', () => {
  assert.equal(learnFromPick(DRAFT, candidate({ id: 'a' })), null);
  assert.equal(learnFromPick({ title: null }, candidate({ id: 'a' })), null);
  assert.equal(learnFromPick({ title: 'ab' }, candidate({ id: 'a' })), null);
});

test('het volgende kaartje van die zaal komt er wél door', () => {
  const geleerd = applyMemory(TICKET, { bma: 'Paradiso' });
  assert.equal(geleerd.title, null);
  assert.equal(geleerd.venue, 'Paradiso');

  // Zaal + datum dragen de match nu, en de titel telt niet als nul mee.
  const result = matchEvent(geleerd, [
    candidate({ id: 'a' }),
    candidate({ id: 'b', startsAt: '2026-11-02T20:30:00+01:00' }),
  ]);
  assert.equal(result.ranked[0].parts.title, null);
  assert.equal(result.ranked[0].candidate.id, 'a');
  // Wel tonen, niet zelf voorstellen: zonder titel kan het de andere zaal
  // in hetzelfde gebouw zijn.
  assert.equal(result.level, 'medium');
});

test('een zaal die we niet geleerd hebben laat de herkenning met rust', () => {
  assert.deepEqual(applyMemory(TICKET, { iets: 'Bimhuis' }), TICKET);
});
