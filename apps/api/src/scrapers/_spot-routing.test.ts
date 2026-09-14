import assert from 'node:assert/strict';
import { test } from 'node:test';

import { venueVoorAdres } from './_spot-page.js';

test('routering op de pandnaam', () => {
  assert.equal(
    venueVoorAdres('SPOT/De Oosterpoort, Kleine zaal / Trompsingel 27, 9724 DA Groningen'),
    'de-oosterpoort'
  );
  assert.equal(
    venueVoorAdres('SPOT/Stadsschouwburg, Turfsingel 86, 9712 KR Groningen'),
    'spot-stadsschouwburg'
  );
  assert.equal(
    venueVoorAdres('SPOT/USVA, Munnekeholm 10, 9711 JA Groningen'),
    'spot-usva'
  );
});

test('routering op de straat als de pandnaam ontbreekt', () => {
  // Dit kostte vijf Oosterpoort-voorstellingen: hun adresveld is niet
  // consistent en soms staat er alleen een straatadres.
  assert.equal(venueVoorAdres('Trompsingel 27, 9724 DA Groningen'), 'de-oosterpoort');
  assert.equal(venueVoorAdres('Haddingestraat 23, 9711 KC Groningen'), 'spot-lutherse-kerk');
});

test('een spatie vóór de komma mag niet uitmaken', () => {
  assert.equal(
    venueVoorAdres('SPOT/Nieuwe Kerk , Nieuwe Kerkhof 1, Groningen, 9712 PT Groningen'),
    'spot-nieuwe-kerk'
  );
});

test('vreemde locaties blijven buiten beeld', () => {
  // Martiniplaza is een eigen organisatie waar SPOT af en toe iets
  // co-presenteert; één show zou de indruk wekken dat we hun programma
  // hebben.
  assert.equal(venueVoorAdres('Martiniplaza'), null);
  assert.equal(venueVoorAdres('Stadspark, Groningen'), null);
  assert.equal(venueVoorAdres(null), null);
});
