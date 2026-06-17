/**
 * Unit tests voor de pure retrieval-kern (geen DB, geen AI). Run met:
 *   pnpm --filter @andreas/api test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PreferenceProfile } from './types.js';
import { EMPTY_PROFILE } from './types.js';

import {
  detectWhenOverride,
  extractKeywords,
  haversineKm,
  inferCategories,
  priceTierFromCents,
  rankCandidates,
  resolveWhenWindow,
  vibeOf,
  type CandidateRow,
} from './retrieval-core.js';

// Paradiso ≈ (52.3622, 4.8836). Amsterdam-centrum referentie.
const ORIGIN = { lat: 52.3676, lng: 4.9041 };

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: over.id ?? 'evt_1',
    title: over.title ?? 'Test Event',
    venueId: over.venueId ?? 'ven_1',
    venueName: over.venueName ?? 'Test Venue',
    start: over.start ?? new Date('2026-06-16T20:00:00Z'),
    end: over.end ?? null,
    category: over.category ?? 'Muziek',
    genres: over.genres ?? [],
    priceCents: over.priceCents ?? null,
    lat: over.lat ?? ORIGIN.lat,
    lng: over.lng ?? ORIGIN.lng,
    scene: over.scene ?? null,
    subtype: over.subtype ?? [],
    lineup: over.lineup ?? [],
  };
}

function profile(over: Partial<PreferenceProfile> = {}): PreferenceProfile {
  return { ...EMPTY_PROFILE, ...over };
}

// ─── priceTierFromCents ──────────────────────────────────────────────────────

test('priceTierFromCents: grenzen', () => {
  assert.equal(priceTierFromCents(null), null);
  assert.equal(priceTierFromCents(0), 0);
  assert.equal(priceTierFromCents(1500), 1);
  assert.equal(priceTierFromCents(1501), 2);
  assert.equal(priceTierFromCents(3500), 2);
  assert.equal(priceTierFromCents(3501), 3);
});

// ─── haversine ───────────────────────────────────────────────────────────────

test('haversineKm: zelfde punt = 0', () => {
  assert.equal(haversineKm(ORIGIN, ORIGIN), 0);
});

test('haversineKm: ~1.5km tussen centrum en Paradiso', () => {
  const d = haversineKm(ORIGIN, { lat: 52.3622, lng: 4.8836 });
  assert.ok(d > 1 && d < 2, `verwacht 1–2km, kreeg ${d}`);
});

// ─── vibe ────────────────────────────────────────────────────────────────────

test('vibeOf: scene + subtype, ge-dedupe', () => {
  assert.deepEqual(
    vibeOf({ scene: 'underground', subtype: ['techno', 'underground'] }),
    ['underground', 'techno']
  );
});

// ─── rankCandidates: harde filters ───────────────────────────────────────────

test('rankCandidates: sluit afgewezen venue en event uit', () => {
  const rows = [
    row({ id: 'a', venueId: 'ven_a' }),
    row({ id: 'b', venueId: 'ven_b' }),
    row({ id: 'c', venueId: 'ven_c' }),
  ];
  const { candidates } = rankCandidates(
    profile({ excludeVenueIds: ['ven_b'], excludeEventIds: ['c'] }),
    rows
  );
  assert.deepEqual(candidates.map((c) => c.id), ['a']);
});

test('rankCandidates: prijsfilter dropt duurder, behoudt onbekende prijs', () => {
  const rows = [
    row({ id: 'gratis', priceCents: 0 }),
    row({ id: 'duur', priceCents: 5000 }),
    row({ id: 'onbekend', priceCents: null }),
  ];
  const { candidates } = rankCandidates(profile({ priceMax: 1 }), rows);
  const ids = candidates.map((c) => c.id).sort();
  assert.deepEqual(ids, ['gratis', 'onbekend']);
});

test('rankCandidates: straalfilter dropt te ver, alleen met origin', () => {
  const far = { lat: 52.09, lng: 5.12 }; // Utrecht, ~35km
  const rows = [
    row({ id: 'dichtbij' }),
    row({ id: 'ver', lat: far.lat, lng: far.lng }),
  ];
  const withRadius = rankCandidates(
    profile({ origin: ORIGIN, maxDistanceKm: 10 }),
    rows
  );
  assert.deepEqual(withRadius.candidates.map((c) => c.id), ['dichtbij']);

  // Zonder origin: geen straalfilter, ook al staat maxDistanceKm gezet.
  const noOrigin = rankCandidates(profile({ maxDistanceKm: 10 }), rows);
  assert.equal(noOrigin.candidates.length, 2);
});

// ─── rankCandidates: zachte sortering ────────────────────────────────────────

test('rankCandidates: want boost, avoid degradeert (geen hard filter)', () => {
  const rows = [
    row({ id: 'mismatch', start: new Date('2026-06-16T19:00:00Z') }),
    row({ id: 'wanted', genres: ['techno'], start: new Date('2026-06-16T22:00:00Z') }),
    row({ id: 'avoided', genres: ['jazz'], start: new Date('2026-06-16T20:00:00Z') }),
  ];
  const { candidates } = rankCandidates(
    profile({ want: ['techno'], avoid: ['jazz'] }),
    rows
  );
  // wanted bovenaan, avoided onderaan — maar nog steeds aanwezig.
  assert.deepEqual(candidates.map((c) => c.id), ['wanted', 'mismatch', 'avoided']);
});

test('rankCandidates: gelijke score sorteert op starttijd', () => {
  const rows = [
    row({ id: 'laat', start: new Date('2026-06-16T23:00:00Z') }),
    row({ id: 'vroeg', start: new Date('2026-06-16T19:00:00Z') }),
  ];
  const { candidates } = rankCandidates(profile(), rows);
  assert.deepEqual(candidates.map((c) => c.id), ['vroeg', 'laat']);
});

test('inferCategories: band/concert → Muziek, film → Film', () => {
  assert.deepEqual(inferCategories('zijn er deze week band optredens?'), ['Muziek']);
  assert.deepEqual(inferCategories('een concert vanavond'), ['Muziek']);
  assert.deepEqual(inferCategories('een goede film nearby'), ['Film']);
  assert.deepEqual(inferCategories('iets met toneel of cabaret'), ['Theater']);
  assert.deepEqual(inferCategories('iets leuks'), []);
});

test('rankCandidates: categorie-boost tilt gevraagde categorie boven eerder event', () => {
  const rows = [
    row({ id: 'film-vroeg', category: 'Film', start: new Date('2026-06-16T19:00:00Z') }),
    row({ id: 'band-laat', category: 'Muziek', start: new Date('2026-06-18T20:00:00Z') }),
  ];
  // Zonder categorie-wens wint het vroegste (film).
  assert.equal(rankCandidates(profile(), rows).candidates[0].id, 'film-vroeg');
  // Met "band"-categorie wint de muziek-avond, ook al is 'ie later.
  const withCat = rankCandidates(profile(), rows, ['Muziek']);
  assert.equal(withCat.candidates[0].id, 'band-laat');
});

test('extractKeywords: eigennamen blijven, stop-/tijdwoorden eruit', () => {
  assert.deepEqual(
    extractKeywords("Aankomende week is guns 'n roses zelfs in de ziggo").sort(),
    ['guns', 'roses', 'ziggo']
  );
  assert.deepEqual(extractKeywords('zijn er deze week band optredens?'), []);
});

test('rankCandidates: trefwoord op titel/venue haalt genoemd event boven', () => {
  const rows = [
    row({ id: 'film-vroeg', category: 'Film', start: new Date('2026-06-16T19:00:00Z') }),
    row({
      id: 'gnr',
      title: "Guns N' Roses — World Tour 2026",
      venueName: 'Ziggo Dome',
      category: 'Muziek',
      start: new Date('2026-06-18T17:30:00Z'),
    }),
  ];
  const { candidates } = rankCandidates(
    profile(),
    rows,
    ['Muziek'],
    ['guns', 'roses', 'ziggo']
  );
  assert.equal(candidates[0].id, 'gnr');
});

test('rankCandidates: trefwoord op line-up-naam haalt event boven (act niet in titel)', () => {
  const rows = [
    row({ id: 'andere', title: 'Willekeurige clubavond', start: new Date('2026-06-16T22:00:00Z') }),
    row({
      id: 'lineup-hit',
      title: 'Madam by Night',
      venueName: 'Madam',
      start: new Date('2026-06-18T22:00:00Z'),
      lineup: ['LevyM', 'Ryan Elliott'],
    }),
  ];
  const { candidates } = rankCandidates(profile(), rows, [], ['elliott']);
  assert.equal(candidates[0].id, 'lineup-hit');
});

test('rankCandidates: genre-match (incl. doorgedruppelde artiest-genres) haalt event boven', () => {
  // `genres` is op DB-niveau al effective_genres: eigen + line-up-artiest-
  // genres. Hier simuleren we een clubavond die via de DJ 'techno' bevat.
  const rows = [
    row({ id: 'geen-techno', title: 'Akoestische avond', genres: ['folk'], start: new Date('2026-06-16T20:00:00Z') }),
    row({
      id: 'techno-via-dj',
      title: 'Madam by Night',
      genres: ['electronic', 'techno', 'house'],
      start: new Date('2026-06-18T22:00:00Z'),
    }),
  ];
  const { candidates } = rankCandidates(profile(), rows, ['Muziek'], ['techno']);
  assert.equal(candidates[0].id, 'techno-via-dj');
});

test('inferCategories: popmuziek/livemuziek herkend als Muziek', () => {
  assert.deepEqual(inferCategories('popmuziek volgende week'), ['Muziek']);
  assert.deepEqual(inferCategories('iets met livemuziek'), ['Muziek']);
  assert.deepEqual(inferCategories('singer-songwriter'), ['Muziek']);
});

test('rankCandidates: categorie hard-filtert — geen film in een muziekvraag', () => {
  const rows = [
    row({ id: 'film1', category: 'Film' }),
    row({ id: 'film2', category: 'Film' }),
    row({ id: 'muziek1', category: 'Muziek' }),
  ];
  const { candidates } = rankCandidates(profile(), rows, ['Muziek']);
  assert.deepEqual(candidates.map((c) => c.id), ['muziek1']);
});

test('rankCandidates: geen events in gevraagde categorie → leeg + sparse', () => {
  const rows = [row({ id: 'f1', category: 'Film' }), row({ id: 'f2', category: 'Film' })];
  const res = rankCandidates(profile(), rows, ['Muziek']);
  assert.equal(res.candidates.length, 0);
  assert.equal(res.sparse, true);
});

test('rankCandidates: sparse-vlag onder de drempel', () => {
  assert.equal(rankCandidates(profile(), [row()]).sparse, true);
  const three = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
  assert.equal(rankCandidates(profile(), three).sparse, false);
});

// ─── resolveWhenWindow ───────────────────────────────────────────────────────

test('resolveWhenWindow tonight: tot eerstvolgende 06:00 NL', () => {
  // Dinsdag 16 jun 2026, 21:00 NL = 19:00 UTC (zomertijd, UTC+2).
  const now = new Date('2026-06-16T19:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'tonight' }), now);
  assert.equal(from.getTime(), now.getTime());
  // 06:00 NL op 17 jun = 04:00 UTC.
  assert.equal(to.toISOString(), '2026-06-17T04:00:00.000Z');
});

test('resolveWhenWindow tonight na middernacht: hoort bij avond ervoor', () => {
  // Woensdag 17 jun 03:00 NL = 01:00 UTC. Logische dag = di 16 jun → to = 17 jun 06:00 NL.
  const now = new Date('2026-06-17T01:00:00Z');
  const { to } = resolveWhenWindow(profile({ when: 'tonight' }), now);
  assert.equal(to.toISOString(), '2026-06-17T04:00:00.000Z');
});

test('resolveWhenWindow specific: 06:00 → +24u', () => {
  const { from, to } = resolveWhenWindow(
    profile({ when: 'specific', whenDate: '2026-06-20' }),
    new Date('2026-06-16T12:00:00Z')
  );
  // 06:00 NL (zomertijd) = 04:00 UTC.
  assert.equal(from.toISOString(), '2026-06-20T04:00:00.000Z');
  assert.equal(to.toISOString(), '2026-06-21T04:00:00.000Z');
});

test('resolveWhenWindow this_week: nu → +7 dagen 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // di 16 jun 12:00 NL
  const { from, to } = resolveWhenWindow(profile({ when: 'this_week' }), now);
  assert.equal(from.getTime(), now.getTime());
  // logische dag = di 16 jun 06:00; +7 = di 23 jun 06:00 NL = 04:00 UTC.
  assert.equal(to.toISOString(), '2026-06-23T04:00:00.000Z');
});

test('detectWhenOverride: expliciete periode-woorden', () => {
  assert.equal(detectWhenOverride('welke techno is er deze maand?'), 'this_month');
  assert.equal(detectWhenOverride('wat speelt er dit jaar nog'), 'this_year');
  assert.equal(detectWhenOverride('iets leuks deze week'), 'this_week');
  assert.equal(detectWhenOverride('dit weekend dansen'), 'this_weekend');
  assert.equal(detectWhenOverride('techno vanavond'), 'tonight');
  // Geen periode genoemd → null (laat LLM-when staan).
  assert.equal(detectWhenOverride('iets met techno, niet te ver'), null);
  // "vrijdag" is een specifieke dag → geen override (LLM zet whenDate).
  assert.equal(detectWhenOverride('techno op vrijdag'), null);
  // Breedste wint: "deze maand" boven niets.
  assert.equal(detectWhenOverride('deze maand een keer dansen'), 'this_month');
  // Verbreed-intenties zonder concrete eenheid → this_month.
  assert.equal(detectWhenOverride('heb je een langere periode?'), 'this_month');
  assert.equal(detectWhenOverride('kun je verder vooruit kijken'), 'this_month');
  assert.equal(detectWhenOverride('komende week dan?'), 'this_week');
  assert.equal(detectWhenOverride('later deze week'), 'this_week');
  // "volgende X" = vooruit geschoven, niet de lopende periode.
  assert.equal(detectWhenOverride('graag echt volgende week niet deze week'), 'next_week');
  assert.equal(detectWhenOverride('en volgend weekend?'), 'next_weekend');
  assert.equal(detectWhenOverride('heb je iets volgende maand'), 'next_month');
});

test('resolveWhenWindow next_week: komende maandag → maandag erna (06:00 NL)', () => {
  // Dinsdag 16 jun 2026, 12:00 NL. Deze week = ma 15 jun; volgende week = ma 22 jun.
  const now = new Date('2026-06-16T10:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'next_week' }), now);
  assert.equal(from.toISOString(), '2026-06-22T04:00:00.000Z'); // ma 22 jun 06:00 NL
  assert.equal(to.toISOString(), '2026-06-29T04:00:00.000Z'); // ma 29 jun 06:00 NL
});

test('resolveWhenWindow next_week begint ná deze week (geen overlap met nu)', () => {
  const now = new Date('2026-06-16T10:00:00Z');
  const thisW = resolveWhenWindow(profile({ when: 'this_week' }), now);
  const nextW = resolveWhenWindow(profile({ when: 'next_week' }), now);
  assert.ok(nextW.from.getTime() >= thisW.to.getTime() - 24 * 3600 * 1000);
  assert.ok(nextW.from.getTime() > now.getTime());
});

test('resolveWhenWindow next_weekend: vr ná dit weekend', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // di 16 jun
  const { from, to } = resolveWhenWindow(profile({ when: 'next_weekend' }), now);
  // dit weekend = vr 19; volgend = vr 26 jun 18:00 → ma 29 jun 06:00.
  assert.equal(from.toISOString(), '2026-06-26T16:00:00.000Z'); // vr 26 jun 18:00 NL
  assert.equal(to.toISOString(), '2026-06-29T04:00:00.000Z'); // ma 29 jun 06:00 NL
});

test('resolveWhenWindow this_month: nu → 1e volgende maand 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z'); // juni
  const { from, to } = resolveWhenWindow(profile({ when: 'this_month' }), now);
  assert.equal(from.getTime(), now.getTime());
  assert.equal(to.toISOString(), '2026-07-01T04:00:00.000Z'); // 1 jul 06:00 NL
});

test('resolveWhenWindow this_month: december rolt naar januari', () => {
  const now = new Date('2026-12-10T12:00:00Z'); // dec 13:00 NL (wintertijd UTC+1)
  const { to } = resolveWhenWindow(profile({ when: 'this_month' }), now);
  assert.equal(to.toISOString(), '2027-01-01T05:00:00.000Z'); // 1 jan 06:00 NL = 05:00 UTC
});

test('resolveWhenWindow this_year: nu → 1 jan volgend jaar 06:00 NL', () => {
  const now = new Date('2026-06-16T10:00:00Z');
  const { to } = resolveWhenWindow(profile({ when: 'this_year' }), now);
  assert.equal(to.toISOString(), '2027-01-01T05:00:00.000Z');
});

test('resolveWhenWindow this_weekend: vr 18:00 → ma 06:00 NL', () => {
  // Dinsdag 16 jun → komende vrijdag = 19 jun.
  const now = new Date('2026-06-16T10:00:00Z');
  const { from, to } = resolveWhenWindow(profile({ when: 'this_weekend' }), now);
  assert.equal(from.toISOString(), '2026-06-19T16:00:00.000Z'); // vr 18:00 NL
  assert.equal(to.toISOString(), '2026-06-22T04:00:00.000Z'); // ma 06:00 NL
});
