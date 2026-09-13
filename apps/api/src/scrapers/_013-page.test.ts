import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parse013Page,
  parseProgrammaLinks,
  prijsCents,
  zaalVanLocatie,
} from './_013-page.js';

const ldBlok = (node: Record<string, unknown>) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [{ '@type': 'WebPage', name: 'x' }, node],
  })}</script>`;

const musicEvent = (over: Record<string, unknown> = {}) => ({
  '@type': 'MusicEvent',
  identifier: 155786,
  name: 'Extince',
  description: '<p>Eerste alinea.</p><p>Tweede alinea.</p>',
  startDate: '2026-12-30T20:00:00+01:00',
  endDate: '2026-12-30T22:30:00+01:00',
  image: 'https://013.example/extince.jpg',
  location: { '@type': 'Place', name: 'Poppodium 013 - Next' },
  offers: {
    '@type': 'Offer',
    availability: 'https://schema.org/InStock',
    url: 'https://tickets.013.nl/abc',
  },
  ...over,
});

test('permalinks komen uit href, ook met niet-ASCII in de slug', () => {
  const html = `
    <a href="https://www.013.nl/programma/155786/extince">x</a>
    <a href="https://www.013.nl/programma/125430/axel-flóvent">x</a>
    <a href="https://www.013.nl/programma/155786/extince">dubbel</a>
    <a href="https://www.013.nl/nieuws/iets">geen event</a>`;
  assert.deepEqual(parseProgrammaLinks(html), [
    'https://www.013.nl/programma/155786/extince',
    'https://www.013.nl/programma/125430/axel-flóvent',
  ]);
});

test('zaal verliest de 013-vlag maar niet z\'n eigen naam', () => {
  assert.equal(zaalVanLocatie('Poppodium 013 - Main (seated)'), 'Main (seated)');
  assert.equal(zaalVanLocatie('Poppodium 013 - Next'), 'Next');
  assert.equal(zaalVanLocatie('Hall of Fame'), 'Hall of Fame');
  assert.equal(zaalVanLocatie(undefined), null);
});

test('prijs is de laagste rang, niet de eerste die je tegenkomt', () => {
  const html =
    'Entree € 85,80 Premier tickets € 75,80 Rang 1 € 55,80 Rang 3 ' +
    'Incl. servicekosten Datum vr 04 dec';
  assert.equal(prijsCents(html), 5580);
});

test('prijs: komma-streepje, gratis, en niets', () => {
  assert.equal(prijsCents('Entree € 25,- Incl. servicekosten Datum wo'), 2500);
  assert.equal(prijsCents('Entree Gratis Datum wo'), 0);
  assert.equal(prijsCents('Entree Datum wo'), null);
  assert.equal(prijsCents('<p>geen ticketblok</p>'), null);
});

test('prijs kijkt niet voorbij Datum', () => {
  // Het bedrag ná "Datum" hoort bij een ander blok (bv. een aanbieding
  // verderop); dat mag de vanaf-prijs niet omlaag trekken.
  assert.equal(prijsCents('Entree € 30,- Datum vr 04 dec ... vanaf € 5,-'), 3000);
});

test('detailpagina levert een compleet event', () => {
  const ev = parse013Page(
    ldBlok(musicEvent()) + '<div>Entree € 25,- Incl. servicekosten Datum wo</div>',
    'https://www.013.nl/programma/155786/extince'
  );
  assert.ok(ev);
  assert.equal(ev.id, '155786');
  assert.equal(ev.title, 'Extince');
  assert.equal(ev.description, 'Eerste alinea.\n\nTweede alinea.');
  assert.equal(ev.startsAt.toISOString(), '2026-12-30T19:00:00.000Z');
  assert.equal(ev.endsAt?.toISOString(), '2026-12-30T21:30:00.000Z');
  assert.equal(ev.room, 'Next');
  assert.equal(ev.priceCents, 2500);
  assert.equal(ev.soldOut, false);
  assert.equal(ev.ticketUrl, 'https://tickets.013.nl/abc');
});

test('uitverkocht komt uit offers.availability', () => {
  const ev = parse013Page(
    ldBlok(
      musicEvent({
        offers: { availability: 'https://schema.org/OutOfStock', url: 'https://t' },
      })
    ),
    'https://x'
  );
  assert.equal(ev?.soldOut, true);
});

test('eindtijd vóór de starttijd telt niet', () => {
  const ev = parse013Page(
    ldBlok(musicEvent({ endDate: '2026-12-30T19:00:00+01:00' })),
    'https://x'
  );
  assert.equal(ev?.endsAt, null);
});

test('afgelaste show komt terug met cancelled, niet als niets', () => {
  // 013 haalt de pagina niet weg en houdt de titel schoon ("6lack", niet
  // "6lack [AFGELAST]"), dus de centrale titel-sweep ziet hier niks.
  const ev = parse013Page(
    ldBlok(
      musicEvent({
        eventStatus: 'https://schema.org/EventCancelled',
        offers: { availability: 'https://schema.org/OutOfStock', url: 'https://t' },
      })
    ),
    'https://x'
  );
  assert.ok(ev);
  assert.equal(ev.cancelled, true);
  assert.equal(ev.title, 'Extince');
  // Uitverkocht blijft ook waar, maar de scraper laat afgelast winnen.
  assert.equal(ev.soldOut, true);
});

test('een gewone show is niet afgelast', () => {
  assert.equal(parse013Page(ldBlok(musicEvent()), 'https://x')?.cancelled, false);
});

test('pagina zonder bruikbare JSON-LD geeft null', () => {
  assert.equal(parse013Page('<html><body>404</body></html>', 'https://x'), null);
  // Wel een event-blok, maar zonder identifier: het SEO-samenvattings-
  // blok dat 013 náást het echte event zet.
  assert.equal(
    parse013Page(
      ldBlok({ '@type': 'Event', name: 'Extince', startDate: '2026-12-30T20:00:00+01:00' }),
      'https://x'
    ),
    null
  );
});
