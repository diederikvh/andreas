import assert from 'node:assert/strict';
import { test } from 'node:test';

import { genresOf, KIDS_TITLE_REGEX, mainGenresOf, normalizeGenre } from './genres.js';

/** Alle voorbeelden komen uit de echte data van sep 2026. */

test('alle spellingen van hiphop worden hiphop', () => {
  for (const raw of ['hip-hop', 'hiphop', 'Hip Hop', 'rap', 'trap', 'Hip-Hop/Rap', 'abstract hip-hop', 'k-hip-hop']) {
    assert.deepEqual(genresOf('Muziek', [raw]), ['hiphop'], raw);
  }
});

test('trip-hop is geen hiphop', () => {
  assert.deepEqual(genresOf('Muziek', ['trip-hop']), ['electronic']);
});

test('verzamellabels met een slash tellen niet mee', () => {
  assert.deepEqual(genresOf('Muziek', ['pop / rock']), []);
  assert.deepEqual(genresOf('Muziek', ['klassiekers / tributes']), []);
  assert.deepEqual(genresOf('Muziek', ['funk / soul / jazz']), []);
});

test('een genre geldt alleen binnen z\'n categorie', () => {
  assert.deepEqual(genresOf('Theater', ['hip-hop', 'performance']), []);
  assert.deepEqual(genresOf('Muziek', ['dance']), []);
  assert.deepEqual(genresOf('Theater', ['dance']), ['dans']);
  assert.deepEqual(genresOf('Film', ['drama']), []);
});

test('lastige buren blijven gescheiden', () => {
  assert.deepEqual(genresOf('Muziek', ['rhythm and blues']), ['rnb']);
  assert.deepEqual(genresOf('Muziek', ['baile funk']), ['latin']);
  assert.deepEqual(genresOf('Muziek', ['hardcore']), []);
  assert.deepEqual(genresOf('Muziek', ['dubstep']), ['electronic', 'dnb']);
});

test('techno en house vallen ook onder elektronisch', () => {
  assert.deepEqual(genresOf('Muziek', ['deep house']), ['electronic', 'house']);
  assert.deepEqual(genresOf('Muziek', ['techno']), ['electronic', 'techno']);
});

test('accenten en leestekens maken niet uit', () => {
  assert.equal(normalizeGenre('Poëzie'), 'poezie');
  assert.equal(normalizeGenre('singer – songwriter'), 'singersongwriter');
  assert.deepEqual(genresOf('Literatuur', ['poëzie']), ['spokenword']);
});

test('kinderaanbod wordt herkend, ook alleen aan de titel', () => {
  assert.deepEqual(genresOf('Muziek', ['kinderliedjes', 'hip-hop']), ['hiphop', 'familie']);
  const kids = new RegExp(KIDS_TITLE_REGEX, 'i');
  assert.ok(kids.test('GRRR… ik ben een boze dino! (4+)'));
  assert.ok(kids.test('LENNOX — Muzikaal avontuur voor iedereen vanaf 8 jaar!'));
  assert.ok(!kids.test('WIFEY | 20+'));
  assert.ok(!kids.test('Mula B • PHIL'));
});

test('verzamellabels die wél iets zeggen tellen exact mee', () => {
  assert.deepEqual(genresOf('Muziek', ['Dance / By Night']), ['electronic']);
  assert.deepEqual(genresOf('Muziek', ['singer – songwriter / americana']), ['country', 'singersongwriter']);
  assert.deepEqual(genresOf('Muziek', ['heavy']), ['metal']);
  assert.deepEqual(genresOf('Muziek', ['roots / blues']), ['blues']);
  // Maar "Pop / Rock" blijft niets: pop óf rock?
  assert.deepEqual(genresOf('Muziek', ['Pop / Rock']), []);
});

test('techno en house tellen ook op plek 3, de rest niet', () => {
  assert.deepEqual(mainGenresOf('Muziek', ['house', 'electronic', 'techno']), ['electronic', 'house', 'techno']);
  // Paradiso zet hiphop achter jazz: dat blijft buiten.
  assert.deepEqual(mainGenresOf('Muziek', ['soul', 'jazz', 'hip-hop']), ['soul', 'jazz']);
  assert.deepEqual(mainGenresOf('Muziek', ['a', 'b', 'c', 'techno']), []);
});

test('activiteit herkend aan titel of label, concerten niet', async () => {
  const { isActivity } = await import('./genres.js');
  assert.ok(isActivity('Backstage rondleiding 9 okt', []));
  assert.ok(isActivity('Masterclass — Kian Soltani', []));
  assert.ok(isActivity('Is This It? De Popquiz', []));
  assert.ok(isActivity('Creatief met Eemhart', ['Anders']));
  assert.ok(isActivity('Ik Wil Wat Doen Markt 2026', []));
  assert.ok(!isActivity('Supermarkt Soundsystem', []));
  assert.ok(!isActivity('Tante Joke Karaoke Band', ['Dance / By Night']));
  assert.ok(!isActivity('London Calling - High Tea', ['indie', 'rock']));
  assert.ok(!isActivity('Douwe Bob', ['pop']));
});
