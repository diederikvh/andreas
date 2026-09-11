/**
 * Fixtures zijn de échte OCR-uitkomsten van 11 sep 2026, overgenomen uit
 * de debug-view op `/import` — dezelfde tekst, dezelfde regelhoogtes,
 * inclusief de fouten die ML Kit maakte ("Weterings chans",
 * "Ordernunmmer", het spookblok "D" uit het QR-vlak).
 *
 * Draaien: `pnpm --filter @andreas/mobile test`
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractEventDraft,
  parseDate,
  parseTime,
} from './importMetadata.ts';
import { toServerMetadata } from './importPayload.ts';
import type { OcrResult } from './importOcr.ts';

const VENUES = [
  'Paradiso',
  'Melkweg',
  'De Roma',
  'Bret',
  'OT301',
  'Concertgebouw',
  'Bimhuis',
];

const TODAY = new Date(2026, 8, 11); // 11 september 2026

/** Eén blok per regel, met hoogte — zo levert ML Kit het ook aan. */
function ocr(blocks: [height: number, text: string][]): OcrResult {
  return {
    fullText: blocks.map(([, text]) => text).join('\n'),
    blocks: blocks.map(([height, text]) => ({
      text,
      box: { x: 0, y: 0, width: 100, height },
      lines: text.split('\n').map((line) => ({
        text: line,
        box: { x: 0, y: 0, width: 100, height },
      })),
    })),
  };
}

// Poster: grote titel, layout zegt alles. Inclusief het spookblok "D"
// dat de OCR uit het QR-vlak haalde, met een bounding box van 160px —
// zonder filter wordt dát de titel.
const POSTER = ocr([
  [114, 'PLOEGENDIENST'],
  [54, 'support: Library Card'],
  [64, 'PARADISO'],
  [38, 'Amsterdam'],
  [51, 'zaterdag 18 oktober 2026'],
  [51, 'deuren 19:30 / aanvang 20:30'],
  [160, 'D'],
  [27, 'Ticket 4417993-02'],
  [27, 'Ordernunmmer 3391827'],
]);

// Ticket-PDF: alle regels 10-14px, de titel kleiner dan de venue-regel.
const TICKET_PDF = ocr([
  [10, 'E-\nTICKET'],
  [10, 'PLOEGENDIENST\nsupport : Library Card'],
  [14, 'PARADISO\nWeterings chans 6-8, Amsterdam'],
  [12, 'zaterdag 18 oktober 2026\ndeuren 19:30 - aanvang 20:30'],
  [12, 'Ticket 4417993-02\nOrdernummer 3391827'],
]);

test('poster: grootste regel is de titel, QR-ruis telt niet mee', () => {
  const draft = extractEventDraft(POSTER, {
    venueNames: VENUES,
    today: TODAY,
  });
  assert.equal(draft.title, 'PLOEGENDIENST');
  assert.equal(draft.venue, 'Paradiso');
  assert.equal(draft.date, '2026-10-18');
  assert.equal(draft.time, '20:30'); // aanvang, niet deuren
  assert.equal(draft.city, 'Amsterdam');
  assert.deepEqual(draft.artists, ['PLOEGENDIENST', 'Library Card']);
});

test('ticket-PDF: zonder grootte-signaal valt hij terug op leesorde', () => {
  const draft = extractEventDraft(TICKET_PDF, {
    venueNames: VENUES,
    today: TODAY,
  });
  // "E-TICKET" is een label en mag de titel niet worden, ook al staat
  // het bovenaan en is het net zo groot als de rest.
  assert.equal(draft.title, 'PLOEGENDIENST');
  assert.equal(draft.venue, 'Paradiso');
  assert.equal(draft.date, '2026-10-18');
  assert.equal(draft.time, '20:30');
  assert.equal(draft.city, 'Amsterdam');
});

test('venue matcht door een OCR-woordbreuk heen', () => {
  const draft = extractEventDraft(
    ocr([[20, 'Concert gebouw'], [30, 'Mahler 4']]),
    { venueNames: VENUES, today: TODAY }
  );
  assert.equal(draft.venue, 'Concertgebouw');
  assert.equal(draft.title, 'Mahler 4');
});

test('korte venuenamen matchen niet zomaar binnen een woord', () => {
  // "Bret" (4) mag niet matchen in "Bretagne"; "OT301" wel als het er staat.
  const draft = extractEventDraft(ocr([[30, 'Bretagne Sessions']]), {
    venueNames: VENUES,
    today: TODAY,
  });
  assert.equal(draft.venue, null);
});

test('geen venue en geen stad in de tekst → city blijft leeg', () => {
  const draft = extractEventDraft(ocr([[40, 'Onbekend Feest']]), {
    venueNames: VENUES,
    today: TODAY,
  });
  assert.equal(draft.venue, null);
  assert.equal(draft.city, null);
  assert.equal(draft.title, 'Onbekend Feest');
});

test('datum zonder jaar pakt het eerstvolgende voorkomen', () => {
  assert.equal(parseDate('18 OKT 20:00', TODAY), '2026-10-18');
  // Maart is voorbij op 11 september, dus volgend jaar.
  assert.equal(parseDate('do 5 maart', TODAY), '2027-03-05');
  assert.equal(parseDate('vrijdag 12 september', TODAY), '2026-09-12');
});

test('datumnotaties', () => {
  assert.equal(parseDate('2026-10-18', TODAY), '2026-10-18');
  assert.equal(parseDate('18/10/2026', TODAY), '2026-10-18');
  assert.equal(parseDate('18 October 2026', TODAY), '2026-10-18');
  assert.equal(parseDate('31 februari 2026', TODAY), null);
  assert.equal(parseDate('geen datum hier', TODAY), null);
});

test('tijdnotaties en aanvang-voorkeur', () => {
  assert.equal(parseTime('deuren 19:30 - aanvang 20:30'), '20:30');
  assert.equal(parseTime('doors 19.30 / start 20.30'), '20:30');
  assert.equal(parseTime('20u00'), '20:00');
  assert.equal(parseTime('deuren 19:30'), '19:30'); // enige tijd die er is
  assert.equal(parseTime('kost 12:-'), null);
  assert.equal(parseTime('25:99'), null);
});

test('het concept komt heel door de privacy-whitelist heen', () => {
  // Fase 3 levert het concept, fase 4 stuurt het naar de matcher. Deze
  // check verbindt de twee: wat we hier herkennen moet ook echt mogen, en
  // de ticketregels van de poster mogen er niet in meeliften.
  const draft = extractEventDraft(POSTER, {
    venueNames: VENUES,
    today: TODAY,
  });
  const payload = toServerMetadata(draft);
  assert.deepEqual(payload, {
    title: 'PLOEGENDIENST',
    artists: ['PLOEGENDIENST', 'Library Card'],
    venue: 'Paradiso',
    date: '2026-10-18',
    time: '20:30',
    city: 'Amsterdam',
  });
  const serialized = JSON.stringify(payload);
  for (const leak of ['4417993', '3391827', 'Ticket', 'Ordernu']) {
    assert.equal(serialized.includes(leak), false, `${leak} lekt`);
  }
});
