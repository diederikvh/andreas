import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRomaDetail, parseRomaTiles, romaWallClock } from './_deroma-page.js';

/** Nagebouwd naar de echte markup van deroma.be/agenda. */
const TEGEL = `
<article class="event-tile">
 <a href="/nl/event/floris-francis-arthur-band" class="event-tile__link">
  <figure class="event-tile__figure">
   <img alt="" data-cb-image-format="default_tile" src="https://www.deroma.be/media/cache/default_tile/x.png" />
  </figure>
  <div class="event-tile__info">
   <div class="event-tile__date"><time datetime="2026-09-13"> zo 13 september
                • 20:00 </time></div>
   <div class="event-tile__title-wrapper" data-len="28"><h3 class="event-tile__title">Floris Francis Arthur (band)</h3></div>
   <div class="event-tile__teaser"><p>Melancholische indiefolk in zowel het Engels als Nederlands.</p></div>
   <span aria-label="ticketstatus" class="event-tile__status"> > Wachtlijst </span>
  </div>
 </a>
</article>`;

const UITVERKOCHT = TEGEL
  .replace('floris-francis-arthur-band', 't-dansant-672')
  .replace('Floris Francis Arthur (band)', 'T-dansant')
  .replace('> Wachtlijst', 'Uitverkocht');

test('leest een tegel volledig uit', () => {
  const [t] = parseRomaTiles(`<ol class="events__list"><li>${TEGEL}</li></ol>`);
  assert.equal(t!.url, 'https://www.deroma.be/nl/event/floris-francis-arthur-band');
  assert.equal(t!.title, 'Floris Francis Arthur (band)');
  assert.equal(t!.date, '2026-09-13');
  assert.equal(t!.time, '20:00');
  assert.equal(t!.teaser, 'Melancholische indiefolk in zowel het Engels als Nederlands.');
  assert.equal(t!.soldOut, false);
});

test('ticketstatus bepaalt uitverkocht', () => {
  const [t] = parseRomaTiles(UITVERKOCHT);
  assert.equal(t!.soldOut, true);
  // "Wachtlijst" is niet hetzelfde als uitverkocht.
  assert.equal(parseRomaTiles(TEGEL)[0]!.soldOut, false);
});

test('velden lekken niet tussen tegels', () => {
  const tiles = parseRomaTiles(TEGEL + UITVERKOCHT);
  assert.equal(tiles.length, 2);
  assert.equal(tiles[1]!.title, 'T-dansant');
  assert.equal(tiles[1]!.url.endsWith('/t-dansant-672'), true);
});

test('een tegel zonder tijd achter de bullet geeft time null', () => {
  const zonder = TEGEL.replace('• 20:00 ', '');
  assert.equal(parseRomaTiles(zonder)[0]!.time, null);
});

test('hun datumformaat met de tijdzone erin geplakt', () => {
  // `new Date()` geeft hier Invalid Date op — vandaar deze parser.
  assert.equal(romaWallClock('2026-09-13CEST21:05:00+0200'), '2026-09-13T21:05:00');
  assert.equal(romaWallClock('2026-12-01CET20:30:00+0100'), '2026-12-01T20:30:00');
  assert.equal(romaWallClock('2026-09-13T21:05:00'), '2026-09-13T21:05:00');
  assert.equal(romaWallClock('binnenkort'), null);
  assert.equal(romaWallClock(null), null);
});

test('detailpagina levert omschrijving, zaal en eindtijd', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Event',
    name: 'Floris Francis Arthur (band)',
    description: 'Donkere, melancholische lo-fi indiefolk.',
    startDate: '2026-09-13CEST20:00:00+0200',
    endDate: '2026-09-13CEST21:05:00+0200',
    location: { '@type': 'Place', name: 'Amor' },
  })}</script>`;
  const d = parseRomaDetail(html);
  assert.equal(d.description, 'Donkere, melancholische lo-fi indiefolk.');
  assert.equal(d.room, 'Amor');
  assert.equal(d.endLocal, '2026-09-13T21:05:00');
});

test('geen of kapotte json-ld geeft lege velden, geen exceptie', () => {
  assert.deepEqual(parseRomaDetail('<html></html>'), { description: null, room: null, endLocal: null });
  assert.deepEqual(
    parseRomaDetail('<script type="application/ld+json">{kapot</script>'),
    { description: null, room: null, endLocal: null }
  );
});
