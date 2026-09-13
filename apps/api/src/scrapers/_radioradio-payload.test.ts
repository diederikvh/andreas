import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRadioRadioEvents } from './_radioradio-payload.js';

/** Devalue: elk geheel getal is een index in dezelfde array. */
const pagina = (arr: unknown[]) =>
  `<html><body><script type="application/json" id="__NUXT_DATA__">${JSON.stringify(arr)}</script></body></html>`;

test('lost verwijzingen op naar echte waarden', () => {
  //  0: root        1: {allEvents:2}   2: [3]
  //  3: event       4..: velden
  const arr: unknown[] = [
    { data: 1 },
    { allEvents: 2 },
    [3],
    { id: 4, title: 5, date: 6, startTime: 7, description: 8, image: 9 },
    'I37xMk2pTR62kPOGOAl0AA',
    'Fantastic Man • Jaimy',
    '2026-09-18',
    '23:00',
    '',
    null,
  ];
  const evs = parseRadioRadioEvents(pagina(arr));
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.id, 'I37xMk2pTR62kPOGOAl0AA');
  assert.equal(evs[0]!.title, 'Fantastic Man • Jaimy');
  assert.equal(evs[0]!.startTime, '23:00');
});

test('gedeelde takken worden maar één keer uitgepakt', () => {
  // Twee events wijzen naar dezelfde titel-string (index 6).
  const arr: unknown[] = [
    { data: 1 }, { allEvents: 2 }, [3, 4],
    { id: 5, title: 6 },
    { id: 7, title: 6 },
    'a', 'Zelfde naam', 'b',
  ];
  const evs = parseRadioRadioEvents(pagina(arr));
  assert.equal(evs.length, 2);
  assert.equal(evs[0]!.title, 'Zelfde naam');
  assert.equal(evs[1]!.title, 'Zelfde naam');
});

test('een verwijzing naar zichzelf loopt niet vast', () => {
  // index 4 wijst naar een object dat naar zichzelf terugwijst
  const arr: unknown[] = [
    { data: 1 }, { allEvents: 2 }, [3],
    { id: 5, title: 6, zelf: 4 },
    { terug: 3 },
    'x', 'Titel',
  ];
  const evs = parseRadioRadioEvents(pagina(arr));
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.title, 'Titel');
});

test('zonder __NUXT_DATA__ of met kapotte json: lege lijst, geen exceptie', () => {
  assert.deepEqual(parseRadioRadioEvents('<html></html>'), []);
  assert.deepEqual(
    parseRadioRadioEvents('<script type="application/json" id="__NUXT_DATA__">{kapot</script>'),
    []
  );
});

test('records zonder id tellen niet mee', () => {
  const arr: unknown[] = [
    { data: 1 }, { allEvents: 2 }, [3, 4],
    { id: 5, title: 6 },
    { title: 6 },
    'a', 'Titel',
  ];
  assert.equal(parseRadioRadioEvents(pagina(arr)).length, 1);
});
