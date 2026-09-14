import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseBeschrijving,
  parseDoornroosjeLinks,
  parseDoornroosjePage,
  parseGenres,
  prijsCents,
  slugVanUrl,
  zichtbareRegels,
} from './_doornroosje-page.js';

const ldBlok = (node: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebPage' }, { '@type': 'Organization' }],
  })}</script>` +
  `<script type="application/ld+json">${JSON.stringify(node)}</script>`;

const drEvent = (over: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Hippotraktor',
  // Let op de +00:00: die liegt, de tijd ernaast is Amsterdamse wandklok.
  startDate: '2026-11-05T22:00:00+00:00',
  endDate: '2026-11-06T01:00:00+00:00',
  eventStatus: 'https://schema.org/EventScheduled',
  location: { '@type': 'Place', name: 'Merleyn' },
  description: 'Zware progressieve metal uit België',
  ...over,
});

const pagina = (node: Record<string, unknown> = {}, body = '') =>
  '<html><head>' +
  '<meta property="og:image" content="https://www.doornroosje.nl/app/uploads/x.jpg">' +
  '</head><body>' +
  ldBlok(drEvent(node)) +
  '<p>Hippotraktor</p><p>&euro; 17,50</p><p>Tickets</p>' +
  '<p>locatie:</p><p>Merleyn</p><p>datum:</p><p>donderdag 5 november 2026</p>' +
  '<p>zaal open:</p><p>21:00 uur</p><p>start:</p><p>22:00 uur</p>' +
  (body ||
    '<p>Hippotraktor heeft zich in korte tijd ontwikkeld tot een vaste waarde binnen de progressieve metal.</p>' +
      '<p>Kenmerkend is de balans tussen zware structuren en melodische, atmosferische passages.</p>') +
  '<p>route &amp; bezoek</p><p>Merleyn is gevestigd op Hertogstraat 13.</p>' +
  '<p>genre</p><p>metal, progressive metal, sludge metal</p><p>media</p>' +
  '<a href="https://ticketshop.doornroosje.nl/1942eb">koop</a>' +
  '</body></html>';

test('links: alleen event-permalinks, ontdubbeld', () => {
  const html = `
    <a href="https://www.doornroosje.nl/event/40up-15/">x</a>
    <a href="https://www.doornroosje.nl/event/40up-15/">dubbel</a>
    <a href="https://www.doornroosje.nl/special/iets/">geen event</a>`;
  assert.deepEqual(parseDoornroosjeLinks(html), [
    'https://www.doornroosje.nl/event/40up-15/',
  ]);
  assert.equal(slugVanUrl('https://www.doornroosje.nl/event/40up-15/'), '40up-15');
});

test('de +00:00 in hun startDate wordt genegeerd — wintertijd', () => {
  const ev = parseDoornroosjePage(pagina(), 'https://www.doornroosje.nl/event/x/');
  // 22:00 wandklok in november (CET, UTC+1) = 21:00Z. Zou de offset
  // kloppen, dan stond hier 22:00Z en liep de app een uur voor.
  assert.equal(ev?.startsAt.toISOString(), '2026-11-05T21:00:00.000Z');
  assert.equal(ev?.endsAt?.toISOString(), '2026-11-06T00:00:00.000Z');
});

test('de +00:00 wordt ook in zomertijd genegeerd', () => {
  const ev = parseDoornroosjePage(
    pagina({ startDate: '2026-09-18T21:00:00+00:00', endDate: null }),
    'https://www.doornroosje.nl/event/x/'
  );
  // September = CEST (UTC+2), dus 21:00 wandklok = 19:00Z.
  assert.equal(ev?.startsAt.toISOString(), '2026-09-18T19:00:00.000Z');
  assert.equal(ev?.endsAt, null);
});

test('detailpagina levert zaal, prijs, genres, beeld en ticket', () => {
  const ev = parseDoornroosjePage(pagina(), 'https://www.doornroosje.nl/event/hippotraktor/');
  assert.ok(ev);
  assert.equal(ev.slug, 'hippotraktor');
  assert.equal(ev.room, 'Merleyn');
  assert.equal(ev.priceCents, 1750);
  assert.deepEqual(ev.genres, ['metal', 'progressive metal', 'sludge metal']);
  assert.equal(ev.imageUrl, 'https://www.doornroosje.nl/app/uploads/x.jpg');
  assert.equal(ev.ticketUrl, 'https://ticketshop.doornroosje.nl/1942eb');
  assert.equal(ev.cancelled, false);
  assert.match(ev.description ?? '', /^Hippotraktor heeft zich/);
  assert.match(ev.description ?? '', /atmosferische passages\.$/);
});

test('beschrijving pakt niet de routetekst of de knoppen mee', () => {
  const ev = parseDoornroosjePage(pagina(), 'https://www.doornroosje.nl/event/x/');
  assert.doesNotMatch(ev?.description ?? '', /Hertogstraat/);
  assert.doesNotMatch(ev?.description ?? '', /route/);
  assert.doesNotMatch(ev?.description ?? '', /^Tickets$/m);
});

test('zonder body-tekst valt de beschrijving terug op de teaser', () => {
  const ev = parseDoornroosjePage(
    pagina({}, '<p>kort</p>'),
    'https://www.doornroosje.nl/event/x/'
  );
  assert.equal(ev?.description, 'Zware progressieve metal uit België');
});

test('prijs: laagste uit het kopblok, komma of punt', () => {
  assert.equal(prijsCents(zichtbareRegels('<p>X</p><p>€ 21.50</p><p>Groepsticket 4x:</p><p>€ 82</p><p>locatie:</p>')), 2150);
  assert.equal(prijsCents(zichtbareRegels('<p>X</p><p>€ 17,50</p><p>locatie:</p>')), 1750);
  assert.equal(prijsCents(zichtbareRegels('<p>X</p><p>Gratis</p><p>locatie:</p>')), 0);
  assert.equal(prijsCents(zichtbareRegels('<p>X</p><p>locatie:</p>')), null);
});

test('prijs kijkt niet voorbij locatie:', () => {
  // Een bedrag verderop hoort bij iets anders (bv. een aanbieding in de
  // tekst) en mag de entreeprijs niet omlaag trekken.
  assert.equal(
    prijsCents(zichtbareRegels('<p>X</p><p>€ 30,-</p><p>locatie:</p><p>Merleyn</p><p>vanaf € 5</p>')),
    3000
  );
});

test('genre-regel splitst op komma; een label is geen genre', () => {
  assert.deepEqual(parseGenres(['genre', 'metal, sludge metal']), ['metal', 'sludge metal']);
  assert.deepEqual(parseGenres(['genre', 'locatie:']), []);
  assert.deepEqual(parseGenres(['media']), []);
});

test('afgelast komt uit eventStatus', () => {
  const ev = parseDoornroosjePage(
    pagina({ eventStatus: 'https://schema.org/EventCancelled' }),
    'https://www.doornroosje.nl/event/x/'
  );
  assert.equal(ev?.cancelled, true);
  // De titel blijft schoon, dus de centrale titel-sweep ziet hier niks.
  assert.equal(ev?.title, 'Hippotraktor');
});

test('pagina zonder Event-node geeft null', () => {
  assert.equal(parseDoornroosjePage('<html><body>404</body></html>', 'https://www.doornroosje.nl/event/x/'), null);
  assert.equal(parseBeschrijving(['geen labels hier']), null);
});
