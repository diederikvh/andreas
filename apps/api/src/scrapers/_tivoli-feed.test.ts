import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  categorieVanGenre,
  extractProductionJson,
  parseTivoliFeed,
} from './_tivoli-feed.js';

/** Nagebouwd naar de echte feed: JSON in CDATA, met staarttekst erachter. */
function item(productie: Record<string, unknown>, staart = 'Het bericht Foo verscheen eerst op TivoliVredenburg.') {
  return `<item><title>x</title><link>https://www.tivolivredenburg.nl/agenda/99401068/foo-13-09-2026</link>` +
    `<content:encoded><![CDATA[<p>${JSON.stringify({ production: productie })}</p> <p>${staart}</p> ]]></content:encoded></item>`;
}

const BASIS = {
  displayId: '99401068',
  publicTitleWebsite: 'Hawkwind',
  subTitle: 'Spacerock',
  startDatetime: '2026-09-13T17:00:00.000Z',
  endDatetime: '2026-09-13T20:15:00.000Z',
  mainContent: 'De legendarische band.',
  publicGenre: 'Pop / Rock',
  publishToWebsite: true,
  ticketStatus: 'For sale',
  priceOverride: 27.5,
  externalTicketLink: 'https://ticket.tivolivredenburg.nl/x',
  locations: [{ name: 'Ronda', showOnWebsite: true }],
  defaultDigitalAsset: { urls: { landscape_large: 'https://media.tivolivredenburg.nl/abc' } },
};

test('leest een item volledig uit', () => {
  const [e] = parseTivoliFeed(item(BASIS));
  assert.equal(e!.id, '99401068');
  assert.equal(e!.title, 'Hawkwind');
  assert.equal(e!.startUtc, '2026-09-13T17:00:00.000Z');
  assert.equal(e!.room, 'Ronda');
  assert.equal(e!.priceCents, 2750);
  assert.equal(e!.imageUrl, 'https://media.tivolivredenburg.nl/abc');
  assert.equal(e!.genre, 'Pop / Rock');
});

test('staarttekst na het json-object breekt het parsen niet', () => {
  // Zonder accolade-tellen slurpt een greedy match die staart mee.
  assert.equal(parseTivoliFeed(item(BASIS, 'Nog wat proza met } en { erin.')).length, 1);
});

test('rauwe stuurtekens in de omschrijving worden opgevangen', () => {
  // Het CMS laat harde regelovergangen staan; JSON.parse struikelt daar
  // normaal over.
  const ruw = `{"production":{"displayId":"1","publicTitle":"X","startDatetime":"2026-09-13T17:00:00.000Z","mainContent":"regel1
regel2"}}`;
  const p = extractProductionJson(ruw);
  assert.ok(p, 'moet toch parsen');
  assert.match(String(p!.mainContent), /regel1\s*regel2/);
});

test('dubbele zalen worden ontdubbeld', () => {
  const [e] = parseTivoliFeed(item({
    ...BASIS,
    locations: [
      { name: 'Cloud Nine', showOnWebsite: true },
      { name: 'Hertz', showOnWebsite: true },
      { name: 'Cloud Nine', showOnWebsite: true },
      { name: 'Buitenwereld', showOnWebsite: false },
    ],
  }));
  assert.equal(e!.room, 'Cloud Nine, Hertz');
});

test('interne producties vallen af', () => {
  assert.equal(parseTivoliFeed(item({ ...BASIS, publishToWebsite: false })).length, 0);
});

test('een item zonder id of starttijd telt niet mee', () => {
  assert.equal(parseTivoliFeed(item({ ...BASIS, displayId: undefined })).length, 0);
  assert.equal(parseTivoliFeed(item({ ...BASIS, startDatetime: undefined })).length, 0);
});

test('genre bepaalt de categorie', () => {
  assert.equal(categorieVanGenre('Pop / Rock'), 'Muziek');
  assert.equal(categorieVanGenre('Klassiek'), 'Muziek');
  assert.equal(categorieVanGenre('Comedy'), 'Theater');
  assert.equal(categorieVanGenre('Familie'), 'Theater');
  assert.equal(categorieVanGenre('Kennis & Debat'), 'Lezing');
  // Onbekend en leeg vallen terug op Muziek — dit is een concertzaal.
  assert.equal(categorieVanGenre('Anders'), 'Muziek');
  assert.equal(categorieVanGenre(null), 'Muziek');
});

test('onzin geeft een lege lijst in plaats van een exceptie', () => {
  assert.deepEqual(parseTivoliFeed('<rss></rss>'), []);
  assert.equal(extractProductionJson('geen json hier'), null);
});
