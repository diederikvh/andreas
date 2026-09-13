import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parsePaardLinks,
  parsePaardPage,
  parseTags,
  schoneTekst,
  slugVanUrl,
} from './_paard-page.js';

const ldBlok = (node: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'x' },
      { '@type': 'Organization', name: 'PAARD' },
      node,
    ],
  })}</script>`;

const paardEvent = (over: Record<string, unknown> = {}) => ({
  '@type': 'Event',
  name: 'STUURBAARD BAKKEBAARD',
  url: 'https://www.paard.nl/event/stuurbaard-bakkebaard/',
  image: 'https://www.paard.nl/wp-content/uploads/2026/05/x.png',
  startDate: '2026-10-18T20:00',
  endDate: '2026-10-18T22:30',
  location: { '@type': 'Place', name: 'Kleine Zaal' },
  offers: {
    '@type': 'offer',
    url: 'https://shop.paylogic.com/abc',
    availability: 'http://schema.org/InStock',
  },
  ...over,
});

test('links: alleen de Nederlandse permalinks, ontdubbeld', () => {
  const html = `
    <a href="https://www.paard.nl/event/40up-47/">x</a>
    <a href="https://www.paard.nl/en/event/40up-12-9-2/">engels</a>
    <a href="https://www.paard.nl/event/40up-47/">dubbel</a>
    <a href="https://www.paard.nl/nieuws/iets/">geen event</a>`;
  assert.deepEqual(parsePaardLinks(html), ['https://www.paard.nl/event/40up-47/']);
});

test('slug komt uit de permalink', () => {
  assert.equal(slugVanUrl('https://www.paard.nl/event/40up-47/'), '40up-47');
  assert.equal(slugVanUrl('https://www.paard.nl/nieuws/'), null);
});

test('tags: genre wel, leeftijdsgrens niet', () => {
  const html =
    '<div class="tickets-intro__tags"> <span>Dance</span> <span>18+</span> </div>';
  assert.deepEqual(parseTags(html), ['dance']);
});

test('tags: entities eruit, meerdere genres blijven', () => {
  const html =
    '<div class="tickets-intro__tags"><span>Caf&eacute;</span><span>R&amp;B</span></div>';
  assert.deepEqual(parseTags(html), ['café', 'r&b']);
  assert.deepEqual(parseTags('<div>geen tag-blok</div>'), []);
});

test('omschrijving: aanhalingstekens eraf, hoogstens één witregel', () => {
  assert.equal(
    schoneTekst('"\n\n\n\n\n40UP bestaat 20 jaar.\n\n\nEn dat vieren we.\n\n\n"'),
    '40UP bestaat 20 jaar.\n\nEn dat vieren we.'
  );
  assert.equal(schoneTekst('   '), null);
  assert.equal(schoneTekst(undefined), null);
});

test('detailpagina levert een compleet event', () => {
  const ev = parsePaardPage(
    ldBlok(paardEvent()) +
      '<div class="tickets-intro__tags"><span>Alternatief</span><span>Indie</span></div>',
    'https://www.paard.nl/event/stuurbaard-bakkebaard/'
  );
  assert.ok(ev);
  assert.equal(ev.slug, 'stuurbaard-bakkebaard');
  assert.equal(ev.title, 'STUURBAARD BAKKEBAARD');
  assert.equal(ev.room, 'Kleine Zaal');
  assert.deepEqual(ev.genres, ['alternatief', 'indie']);
  assert.equal(ev.ticketUrl, 'https://shop.paylogic.com/abc');
  assert.equal(ev.soldOut, false);
  // Wandkloktijd zonder offset: 20:00 in oktober is CEST, dus 18:00Z.
  assert.equal(ev.startsAt.toISOString(), '2026-10-18T18:00:00.000Z');
  assert.equal(ev.endsAt?.toISOString(), '2026-10-18T20:30:00.000Z');
});

test('wintertijd: dezelfde wandklok is een uur later in UTC', () => {
  const ev = parsePaardPage(
    ldBlok(paardEvent({ startDate: '2026-11-29T19:30', endDate: '2026-11-29T22:30' })),
    'https://www.paard.nl/event/x/'
  );
  assert.equal(ev?.startsAt.toISOString(), '2026-11-29T18:30:00.000Z');
});

test('zaalnaam met entity wordt gedecodeerd', () => {
  const ev = parsePaardPage(
    ldBlok(paardEvent({ location: { '@type': 'Place', name: 'Caf&eacute;' } })),
    'https://www.paard.nl/event/x/'
  );
  assert.equal(ev?.room, 'Café');
});

test('eindtijd vóór de starttijd telt niet', () => {
  const ev = parsePaardPage(
    ldBlok(paardEvent({ endDate: '2026-10-18T19:00' })),
    'https://www.paard.nl/event/x/'
  );
  assert.equal(ev?.endsAt, null);
});

test('geen Event-node of geen slug geeft null', () => {
  assert.equal(parsePaardPage('<html>404</html>', 'https://www.paard.nl/event/x/'), null);
  assert.equal(parsePaardPage(ldBlok(paardEvent()), 'https://www.paard.nl/nieuws/'), null);
});
