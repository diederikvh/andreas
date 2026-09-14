import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAmareLinks, parseAmarePage, slugVanUrl } from './_amare-page.js';

const node = (start: string, eind: string, zaal: string) => ({
  '@context': 'http://schema.org',
  '@type': 'Event',
  name: 'Gouwe Ouwe',
  startDate: start,
  endDate: eind,
  image: 'https://img.amare.nl/x',
  description: 'Een feest van herkenning…',
  location: { '@type': 'Place', name: zaal },
});

const pagina = (nodes: unknown[], extra = '') =>
  `<html><body><script type="application/ld+json">${JSON.stringify(
    nodes
  )}</script>${extra}</body></html>`;

test('links uit de agenda-tegels', () => {
  const html = `
    <a href="/nl/agenda/gouwe-ouwe-j48h">x</a>
    <a href="/nl/agenda/gouwe-ouwe-j48h">dubbel</a>
    <a href="/nl/stories/iets">geen event</a>`;
  assert.deepEqual(parseAmareLinks(html), ['https://www.amare.nl/nl/agenda/gouwe-ouwe-j48h']);
  assert.equal(slugVanUrl('https://www.amare.nl/nl/agenda/gouwe-ouwe-j48h'), 'gouwe-ouwe-j48h');
});

test('een reeks komt binnen als één event met meerdere momenten', () => {
  const ev = parseAmarePage(
    pagina([
      node('2026-09-15T14:30:00+02:00', '2026-09-15T16:30:00+02:00', 'Openbare ruimtes'),
      node('2026-12-14T14:30:00+01:00', '2026-12-14T16:30:00+01:00', 'Danszaal'),
    ]),
    'https://www.amare.nl/nl/agenda/gouwe-ouwe-j48h'
  );
  assert.ok(ev);
  assert.equal(ev.momenten.length, 2);
  // Zomertijd en wintertijd, allebei met hun eigen offset in de bron.
  assert.equal(ev.momenten[0].startsAt.toISOString(), '2026-09-15T12:30:00.000Z');
  assert.equal(ev.momenten[1].startsAt.toISOString(), '2026-12-14T13:30:00.000Z');
  // Elke datum houdt z'n eigen zaal.
  assert.equal(ev.momenten[0].room, 'Openbare ruimtes');
  assert.equal(ev.momenten[1].room, 'Danszaal');
});

test('dezelfde datum twee keer telt één keer', () => {
  const ev = parseAmarePage(
    pagina([
      node('2026-09-15T14:30:00+02:00', '2026-09-15T16:30:00+02:00', 'Danszaal'),
      node('2026-09-15T14:30:00+02:00', '2026-09-15T16:30:00+02:00', 'Danszaal'),
    ]),
    'https://www.amare.nl/nl/agenda/x'
  );
  assert.equal(ev?.momenten.length, 1);
});

test('body-tekst wint van de afgekapte JSON-LD-omschrijving', () => {
  const lang = 'Gouwe Ouwe is een feest van herkenning. ' + 'b'.repeat(80);
  const ev = parseAmarePage(
    pagina([node('2026-09-15T14:30:00+02:00', '2026-09-15T16:30:00+02:00', 'Danszaal')], `<p>${lang}</p>`),
    'https://www.amare.nl/nl/agenda/x'
  );
  assert.equal(ev?.description, lang);
});

test('de cookiemuur belandt niet in de omschrijving', () => {
  const cookie = 'We maken gebruik van cookies en vergelijkbare technieken ' + 'c'.repeat(80);
  const ev = parseAmarePage(
    pagina([node('2026-09-15T14:30:00+02:00', '2026-09-15T16:30:00+02:00', 'Danszaal')], `<p>${cookie}</p>`),
    'https://www.amare.nl/nl/agenda/x'
  );
  assert.equal(ev?.description, 'Een feest van herkenning…');
});

test('eindtijd vóór de starttijd telt niet', () => {
  const ev = parseAmarePage(
    pagina([node('2026-09-15T14:30:00+02:00', '2026-09-15T12:30:00+02:00', 'Danszaal')]),
    'https://www.amare.nl/nl/agenda/x'
  );
  assert.equal(ev?.momenten[0].endsAt, null);
});

test('pagina zonder Event geeft null', () => {
  assert.equal(parseAmarePage('<html><body>404</body></html>', 'https://www.amare.nl/nl/agenda/x'), null);
});
