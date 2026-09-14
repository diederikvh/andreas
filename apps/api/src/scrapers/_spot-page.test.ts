import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  pandUitAdres,
  parseBeschrijving,
  parseSpotLinks,
  parseSpotPage,
  prijsCents,
} from './_spot-page.js';

const pagina = (over: Record<string, unknown> = {}, extra = '') =>
  `<html><body>${
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'Drake Milligan',
      description: 'Traditionele country',
      image: 'https://spot.example/x.jpg',
      url: 'https://www.spotgroningen.nl/programma/drake-milligan/',
      startDate: '2026-09-18T20:00:00+02:00',
      endDate: '2026-09-19T00:00:00+02:00',
      location: {
        '@type': 'Place',
        name: 'SPOT Groningen',
        address: 'SPOT/De Oosterpoort, Kleine zaal / Trompsingel 27, 9724 DA Groningen',
      },
      offers: [
        {
          '@type': 'Offer',
          url: 'https://tickets.spotgroningen.nl/x',
          availability: 'http://schema.org/InStock',
          price: '30.00',
        },
      ],
      ...over,
    })}</script>`
  }${extra}</body></html>`;

test('links: rubrieken en seizoenskaarten tellen niet mee', () => {
  const html = `
    <a href="https://www.spotgroningen.nl/programma/drake-milligan/">x</a>
    <a href="https://www.spotgroningen.nl/programma/drake-milligan/">dubbel</a>
    <a href="https://www.spotgroningen.nl/programma/verzameling/english/">rubriek</a>
    <a href="https://www.spotgroningen.nl/programma/abonnement-kamermuziek-3/">kaart</a>`;
  assert.deepEqual(parseSpotLinks(html), [
    'https://www.spotgroningen.nl/programma/drake-milligan/',
  ]);
});

test('pand en zaal komen uit het adres, niet uit location.name', () => {
  // location.name is voor alle vier de panden "SPOT Groningen".
  assert.deepEqual(
    pandUitAdres('SPOT/De Oosterpoort, Kleine zaal / Trompsingel 27, 9724 DA Groningen'),
    { gebouw: 'De Oosterpoort', zaal: 'Kleine zaal' }
  );
  assert.deepEqual(pandUitAdres('SPOT/Stadsschouwburg, Turfsingel 86, 9712 KR Groningen'), {
    gebouw: 'Stadsschouwburg',
    zaal: null,
  });
  assert.deepEqual(pandUitAdres(null), { gebouw: null, zaal: null });
});

test('een deel met een huisnummer is een straat, geen zaal', () => {
  assert.equal(
    pandUitAdres('SPOT/A-Theater, Akerkstraat 11, 9711 JB Groningen').zaal,
    null
  );
});

test('prijs uit hun offer-veld', () => {
  assert.equal(prijsCents('30.00'), 3000);
  assert.equal(prijsCents('46,50'), 4650);
  assert.equal(prijsCents(null), null);
});

test('detailpagina levert een compleet event', () => {
  const ev = parseSpotPage(pagina(), 'https://www.spotgroningen.nl/programma/drake-milligan/');
  assert.ok(ev);
  assert.equal(ev.slug, 'drake-milligan');
  assert.equal(ev.gebouw, 'De Oosterpoort');
  assert.equal(ev.zaal, 'Kleine zaal');
  assert.equal(ev.priceCents, 3000);
  assert.equal(ev.soldOut, false);
  // Echte offset in startDate, dus geen wandklok-omrekening nodig.
  assert.equal(ev.startsAt.toISOString(), '2026-09-18T18:00:00.000Z');
  assert.equal(ev.endsAt?.toISOString(), '2026-09-18T22:00:00.000Z');
});

test('uitverkocht uit availability', () => {
  const ev = parseSpotPage(
    pagina({ offers: [{ availability: 'http://schema.org/SoldOut', price: '30.00' }] }),
    'https://www.spotgroningen.nl/programma/x/'
  );
  assert.equal(ev?.soldOut, true);
});

test('beschrijving: alinea\'s wel, voetregels niet', () => {
  const lang = 'a'.repeat(120);
  const html =
    `<p>${lang}</p><p>kort</p>` +
    `<p>Wij gebruiken cookies ${lang}</p>` +
    `<p>VIP-PAKKET IS EXCLUSIEF ${lang}</p>`;
  const tekst = parseBeschrijving(`<body>${html}</body>`);
  assert.equal(tekst, lang);
});

test('het ruwe adres blijft bewaard voor de routering', () => {
  const ev = parseSpotPage(pagina(), 'https://www.spotgroningen.nl/programma/x/');
  assert.match(ev?.adres ?? '', /Trompsingel 27/);
});

test('pagina zonder Event geeft null', () => {
  assert.equal(parseSpotPage('<html><body>404</body></html>', 'https://www.spotgroningen.nl/programma/x/'), null);
});
