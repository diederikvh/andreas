import assert from 'node:assert/strict';
import { test } from 'node:test';

import { whyMatched } from './service.js';

const alert = {
  genres: ['wave'],
  artistNames: ['Duran Duran', 'OMD'],
  keywords: ['80s', 'new romantic'],
  label: 'muziek · new wave & darkwave · met "80s"',
};
const event = { category: 'Muziek', genres: [] as string[], description: null, lineup: [] as string[], headliner: null };

test('de artiest gaat voor, uit line-up of titel', () => {
  assert.equal(whyMatched(alert, { ...event, title: 'Tour 2027', lineup: ['OMD'] }), 'Met OMD');
  assert.equal(whyMatched(alert, { ...event, title: 'Duran Duran — Future Past' }), 'Met Duran Duran');
});

test('genre en trefwoord samen', () => {
  assert.equal(
    whyMatched(alert, { ...event, title: 'Kim Wilde', genres: ['new wave'], description: 'De grootste hits uit de 80s' }),
    'new wave & darkwave · "80s" in de aankondiging'
  );
});

test('genre via de hoofdact als de zaal niets zegt', () => {
  assert.equal(
    whyMatched(alert, { ...event, title: 'Midge Ure', genres: ['Pop / Rock'], headliner: { name: 'Midge Ure', genres: ['new wave', '80s'] } }),
    'new wave & darkwave, via Midge Ure'
  );
});

test('anders het label van de melding, ingekort', () => {
  assert.equal(whyMatched(alert, { ...event, title: 'Iets' }), 'Past bij je melding: muziek · new wave & darkwave · met "80s"');
});
