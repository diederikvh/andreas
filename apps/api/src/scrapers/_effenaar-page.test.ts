import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dagUitTimestamp,
  eindMoment,
  momentVan,
  parseEffenaarCollectie,
  parseEffenaarDetail,
  prijsCents,
} from './_effenaar-page.js';

const nextData = (props: unknown) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: props },
  })}</script>`;

const hit = (over: Record<string, unknown> = {}) => ({
  search_api_id: 'entity:node/2002:nl',
  slug: '/agenda/new-purple-celebration-3okt',
  title: ' New Purple Celebration',
  subtitle: 'Een reis door hits',
  introduction: '<p>De ultieme Prince-tributeband.</p>',
  date: 1822564800, // 2027-10-03, 12:00 UTC
  locations: [{ id: '116', title: 'Grote zaal', is_external: false }],
  genres: [{ id: '123', title: 'Classics & Legends' }],
  header_image: { image: { src: 'https://cdn.example/prince.png' } },
  ...over,
});

const collectiePagina = (hits: unknown[]) =>
  nextData({
    dehydrated: {
      queries: [
        { queryKey: 'settings-nl', state: { data: {} } },
        {
          queryKey: 'events-collection-nl',
          state: {
            data: {
              pageData: {
                algolia: {
                  serverState: {
                    initialResults: {
                      production_events: { results: [{ hits }] },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
  });

const detailPagina = (pageData: Record<string, unknown>, anderen: unknown[] = []) =>
  nextData({
    queryParams: { queryKey: 'AgendaDetail-new-purple-nl' },
    dehydrated: {
      queries: [
        ...anderen,
        { queryKey: 'AgendaDetail-new-purple-nl', state: { data: { pageData } } },
      ],
    },
  });

test('collectie: de hele agenda uit één pagina', () => {
  const t = parseEffenaarCollectie(collectiePagina([hit(), hit({ search_api_id: 'entity:node/2003:nl' })]));
  assert.equal(t.length, 2);
  assert.equal(t[0].nid, '2002');
  assert.equal(t[0].url, 'https://www.effenaar.nl/agenda/new-purple-celebration-3okt');
  assert.equal(t[0].title, 'New Purple Celebration');
  assert.equal(t[0].room, 'Grote zaal');
  assert.deepEqual(t[0].genres, ['classics & legends']);
  assert.equal(t[0].imageUrl, 'https://cdn.example/prince.png');
  assert.equal(t[0].teaser, 'De ultieme Prince-tributeband.');
  assert.equal(t[0].dagIso, '2027-10-03');
});

test('collectie: dubbele node-ids tellen één keer', () => {
  const t = parseEffenaarCollectie(collectiePagina([hit(), hit()]));
  assert.equal(t.length, 1);
});

test('collectie: state vertaalt naar uitverkocht en afgelast', () => {
  const van = (state: string) =>
    parseEffenaarCollectie(collectiePagina([hit({ state })]))[0];
  assert.equal(van('sold_out').soldOut, true);
  assert.equal(van('sold_out').cancelled, false);
  assert.equal(van('cancelled').cancelled, true);
  // "moved" telt als afgelast: onze datum klopt dan niet meer.
  assert.equal(van('moved').cancelled, true);
  assert.equal(van('last_tickets').soldOut, false);
  assert.equal(parseEffenaarCollectie(collectiePagina([hit()]))[0].soldOut, false);
});

test('collectie: onbruikbare hits vallen af, de rest blijft', () => {
  const t = parseEffenaarCollectie(
    collectiePagina([
      hit({ search_api_id: 'losse-string' }),
      hit({ date: null, search_api_id: 'entity:node/3:nl' }),
      hit({ search_api_id: 'entity:node/4:nl' }),
    ])
  );
  assert.deepEqual(t.map((x) => x.nid), ['4']);
  assert.deepEqual(parseEffenaarCollectie('<html>geen next-data</html>'), []);
});

test('detail: pakt de query van de pagina zelf, niet de eerste', () => {
  // Op een detailpagina staan tientallen AgendaDetail-queries van
  // gerelateerde events. De eerste pakken gaf voor élke pagina hetzelfde
  // event terug.
  const html = detailPagina(
    { title: 'Het goede event', times: { starts_at: '20:15' }, date: { machine: '2027-10-03' } },
    [{ queryKey: 'AgendaDetail-iets-anders-nl', state: { data: { pageData: { title: 'Fout event', times: { starts_at: '10:00' } } } } }]
  );
  const det = parseEffenaarDetail(html);
  assert.equal(det?.startLokaal, '20:15');
  assert.equal(det?.dagIso, '2027-10-03');
});

test('detail: prijs, ticketlink, zaal en tekst', () => {
  const det = parseEffenaarDetail(
    detailPagina({
      times: { starts_at: '20:15', ends_at: null, opens_at: '19:30' },
      date: { machine: '2027-10-03' },
      ticket_price: '31.00',
      ticket_url: { uri: 'https://shop.tickets.cm.com/abc' },
      locations: [{ title: 'Grote zaal' }],
      genres: [{ title: 'Classics & Legends' }],
      content: '<p>Eerste alinea.</p><p>Tweede alinea.</p>',
    })
  );
  assert.equal(det?.priceCents, 3100);
  assert.equal(det?.ticketUrl, 'https://shop.tickets.cm.com/abc');
  assert.equal(det?.room, 'Grote zaal');
  assert.deepEqual(det?.genres, ['classics & legends']);
  assert.equal(det?.description, 'Eerste alinea.\n\nTweede alinea.');
  assert.equal(det?.eindLokaal, null);
});

test('prijs: hun veld is een string, soms niks', () => {
  assert.equal(prijsCents('31.00'), 3100);
  assert.equal(prijsCents('26'), 2600);
  assert.equal(prijsCents('31,95'), 3195);
  assert.equal(prijsCents('7.5'), 750);
  assert.equal(prijsCents(null), null);
  assert.equal(prijsCents('vanaf 20'), null);
});

test('dag: hun timestamp staat op 12:00 UTC, dus de dag is eenduidig', () => {
  assert.equal(dagUitTimestamp(1822564800), '2027-10-03');
  assert.equal(dagUitTimestamp('1789646400'), '2026-09-17');
  assert.equal(dagUitTimestamp('geen getal'), null);
});

test('starttijd is Amsterdamse wandklok, in beide helften van het jaar', () => {
  assert.equal(momentVan('2026-10-10', '18:45')?.toISOString(), '2026-10-10T16:45:00.000Z');
  assert.equal(momentVan('2026-11-04', '20:15')?.toISOString(), '2026-11-04T19:15:00.000Z');
  assert.equal(momentVan('2026-11-04', 'onzin'), null);
});

test('eindtijd rolt door naar de volgende dag', () => {
  // 19:30 tot "00:00" is een avond van 4,5 uur, geen negatieve.
  const eind = eindMoment('2026-11-13', '19:30', '00:00');
  assert.equal(eind?.toISOString(), '2026-11-13T23:00:00.000Z');
  const start = momentVan('2026-11-13', '19:30')!;
  assert.ok(eind!.getTime() > start.getTime());
});

test('eindtijd op dezelfde dag blijft op dezelfde dag', () => {
  assert.equal(
    eindMoment('2026-10-24', '16:00', '23:00')?.toISOString(),
    '2026-10-24T21:00:00.000Z'
  );
});

test('eindtijd over de jaargrens', () => {
  assert.equal(
    eindMoment('2026-12-31', '23:00', '05:00')?.toISOString(),
    '2027-01-01T04:00:00.000Z'
  );
});

test('eindtijd in de nacht van de klokwissel', () => {
  // 25 okt 2026 gaat de klok terug; om 22:00 geldt al CET (+1).
  assert.equal(momentVan('2026-10-25', '22:00')?.toISOString(), '2026-10-25T21:00:00.000Z');
  assert.equal(
    eindMoment('2026-10-25', '22:00', '03:00')?.toISOString(),
    '2026-10-26T02:00:00.000Z'
  );
});

test('geen eindtijd geeft null', () => {
  assert.equal(eindMoment('2026-11-13', '19:30', null), null);
});
