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
  titleFromFileName,
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
  'Cinetol',
  'Paradiso',
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

/* ── Een echt ticket van buiten Amsterdam ──────────────────────────────
 *
 * De Roma, Borgerhout (12 sep 2026). Twee dingen gingen hier mis:
 *
 *  1. Het grootste element op het kaartje is het logo van de zaal, en dat
 *     OCR'de tot "Bma". De "grootste regel wint"-regel koos dat als titel,
 *     terwijl de artiest in normale letters vlak boven de datum staat.
 *  2. De venue en de stad stonden in de adresregel, maar `findVenue` kent
 *     alleen de venues die Andreas al heeft — allemaal Amsterdams. Dus
 *     bleven venue en stad leeg terwijl ze er letterlijk stonden.
 */
test('ticket: het zaal-logo is niet de titel, de adresregel geeft stad', () => {
  const draft = extractEventDraft(
    ocr([
      [180, 'Bma'],
      [34, 'Roosbeef'],
      [24, 'zaterdag 03 april 2027 - 20u00'],
      [20, 'De Roma - Turnhoutsebaan 286 - 2140 Borgerhout'],
      [18, 'met 40% korting.'],
    ]),
    { venueNames: VENUES, today: TODAY, isTicket: true }
  );
  assert.equal(draft.title, 'Roosbeef');
  assert.equal(draft.venue, 'De Roma');
  assert.equal(draft.city, 'Borgerhout');
  assert.equal(draft.date, '2027-04-03');
  assert.equal(draft.time, '20:00');
  // "met 40% korting" heeft dezelfde vorm als "met Library Card", maar een
  // korting is geen support-act.
  assert.deepEqual(draft.artists, ['Roosbeef']);
});

test('poster: zonder ticket-signalen wint de grootste regel nog steeds', () => {
  const draft = extractEventDraft(
    ocr([
      [123, 'LOWERTOWN'],
      [68, 'PARADISO'],
      [46, 'Amsterdam'],
      [54, 'zaterdag 12 september 2026'],
      [46, 'deuren 19:00 / aanvang 19:30'],
    ]),
    { venueNames: VENUES, today: TODAY }
  );
  assert.equal(draft.title, 'LOWERTOWN');
  assert.equal(draft.venue, 'Paradiso');
  assert.equal(draft.city, 'Amsterdam');
});

test('adresregel: stad is wat na de postcode staat, niet de hele regel', () => {
  // Zelfde kaartje, maar met een andere streepjes-glyph dan de eerste —
  // OCR wisselt daar in. De stad moet "Borgerhout" zijn, niet
  // "Turnhoutsebaan 286 - Borgerhout".
  const draft = extractEventDraft(
    ocr([
      [180, 'Bma'],
      [34, 'Roosbeef'],
      [24, 'zaterdag 03 april 2027 - 20u00'],
      [20, 'De Roma − Turnhoutsebaan 286 − 2140 Borgerhout'],
    ]),
    { venueNames: [], today: TODAY, isTicket: true }
  );
  assert.equal(draft.venue, 'De Roma');
  assert.equal(draft.city, 'Borgerhout');
  assert.equal(draft.title, 'Roosbeef');
});

test('adresregel zonder postcode laat de stad leeg in plaats van te gokken', () => {
  const draft = extractEventDraft(
    ocr([
      [40, 'Iets Leuks'],
      [20, 'zaterdag 03 april 2027 - 20u00'],
      [18, 'Ergens - Eenstraat 12'],
    ]),
    { venueNames: [], today: TODAY, isTicket: true }
  );
  assert.equal(draft.venue, 'Ergens');
  assert.equal(draft.city, null);
});

/**
 * Stager-kaartje voor Cinetol, zoals het op 12 sep 2026 uit de app kwam.
 * Het adres staat hier op twee regels onder elkaar in plaats van achter
 * elkaar op één — en daardoor werd "1074 VM Amsterdam" de titel: de
 * postcoderegel is de eerste regel boven de datum.
 */
const STAGER_CINETOL = ocr([
  [45, '(ITL'],
  [36, 'De Nachtelijke Escapades +\nsupport: Scout'],
  [13, 'Cinetol'],
  [13, 'Tolstraat 182\n1074 VM Amsterdam'],
  [23, 'Saturday\n12 September 2026\nOpen\n20:00 20:30\nStart'],
  [15, 'Ticket number\n1/2-ST5935570925479'],
  [10, 'Order number'],
  [15, '13898453'],
  [13, 'Date of purchase\n19-07-2026'],
  [17, 'Name of ticket holder\nDiederik Huijstee'],
  [12, 'Ticket'],
  [18, 'Price (incl. VAT) € 15.25\nService Fees (incl. VAT) € 1.75'],
  [42, 'Stager.'],
]);

test('ticket met het adres onder elkaar: de postcode is geen titel', () => {
  const draft = extractEventDraft(STAGER_CINETOL, {
    venueNames: VENUES,
    today: TODAY,
    isTicket: true,
  });
  assert.equal(draft.title, 'De Nachtelijke Escapades');
  assert.equal(draft.venue, 'Cinetol');
  assert.equal(draft.date, '2026-09-12');
  assert.equal(draft.time, '20:30'); // Start, niet Open
  assert.equal(draft.city, 'Amsterdam');
  assert.deepEqual(draft.artists, ['De Nachtelijke Escapades', 'Scout']);
});

test('een zaal die Andreas niet kent staat boven z\'n eigen adres', () => {
  const draft = extractEventDraft(STAGER_CINETOL, {
    venueNames: [],
    today: TODAY,
    isTicket: true,
  });
  assert.equal(draft.venue, 'Cinetol');
  assert.equal(draft.title, 'De Nachtelijke Escapades');
});

/**
 * Paylogic-kaartje voor Paradiso, 12 sep 2026 uit de app. Het logo loopt
 * achter de QR-code langs, dus de grootste regel op het kaartje leest als
 * "Pagadiso" — en dát werd de titel, want zonder datumregel valt de
 * titelkeuze terug op "het grootste". In de bestandsnaam staat gewoon wie
 * er speelt.
 */
const PARADISO_PAYLOGIC = ocr([
  [258, 'Pagadiso'],
  [17, '1247363607128'],
  [
    26,
    'A membership is required to\nvisit this programme.\nBuy it in advance on\nwww.paradiso.n/membership if you\ndidn\'t do so already.',
  ],
  [
    22,
    'If you can show this ticket on your\nsmartphone, you don\'t need to print it.',
  ],
  [
    21,
    'All times mentioned on this ticket are\nsubject to change. Please check our\nwebsite closer to the event date for\naccurate timings.',
  ],
  [
    22,
    'At this venue, you can only pay by card\n(all debit and credit cards accepted)',
  ],
  [31, 'Venue address'],
  [17, 'Paradiso\nWeteringschans 6-8\n1017 SG Amsterdam'],
  [31, 'Visitor information'],
  [
    17,
    'Visit www.paradiso.nl/visit for all important\ninfo regarding your visit to Paradiso,\nincluding transport recommendations and\ndoors & starting times.',
  ],
  [57, 'Paylogic\nCUstomer Care'],
  [
    22,
    'Do you have a question regarding\nthis ticket? Check our FAQ on\nwww.paradiso.nl/faq, or you can reach\nout to the Paylogic Customer Service\nthrough customerservice.paylogic.com',
  ],
  [17, 'The Afghan Whigs\nOpen 19:30\nNormaal'],
  [15, 'Exclusief verplicht lidmaatschap'],
  [15, 'Prijs:  € 34,30 EUR*  Datum: 28 september 2026 21:00'],
  [17, 'Paradiso - Grote Zaal'],
  [15, 'Bestelnummer:  165876208\nNaam:  Diederik van Huijstee'],
  [17, '8963268943842'],
  [22, 'www.paradiso.nl'],
]);

test('logo achter de QR: de bestandsnaam weet wie er speelt', () => {
  const draft = extractEventDraft(PARADISO_PAYLOGIC, {
    venueNames: VENUES,
    today: TODAY,
    isTicket: true,
    fileName: 'The Afghan Whigs - order 165876208.pdf',
  });
  assert.equal(draft.title, 'The Afghan Whigs');
  assert.equal(draft.venue, 'Paradiso');
  assert.equal(draft.date, '2026-09-28');
  assert.equal(draft.time, '21:00'); // Datum-regel, niet "Open 19:30"
  assert.equal(draft.city, 'Amsterdam');
  assert.deepEqual(draft.artists, ['The Afghan Whigs']);
});

test('ook zonder bestandsnaam: logo en ticketboer zijn geen titel', () => {
  const draft = extractEventDraft(PARADISO_PAYLOGIC, {
    venueNames: VENUES,
    today: TODAY,
    isTicket: true,
  });
  // "Pagadiso" is de zaal met één verkeerde letter, "Paylogic" de
  // ticketboer, en de datum staat achter de prijs geplakt. Alle drie
  // zaten ze eerder in de weg.
  assert.equal(draft.title, 'The Afghan Whigs');
  assert.equal(draft.venue, 'Paradiso');
});

test('de bestandsnaam wint alleen als hij iets anders zegt', () => {
  // Zelfde avond, andere schrijfwijze: dan houden we wat er op het
  // kaartje staat.
  const draft = extractEventDraft(STAGER_CINETOL, {
    venueNames: VENUES,
    today: TODAY,
    isTicket: true,
    fileName:
      'Stager Tickets - Cinetol - Event De Nachtelijke Escapades support Scout.pdf',
  });
  assert.equal(draft.title, 'De Nachtelijke Escapades');
  assert.equal(draft.venue, 'Cinetol');
});

test('wat een bestandsnaam niet is', () => {
  assert.equal(titleFromFileName('download.pdf'), null);
  assert.equal(titleFromFileName('1247363607128.pdf'), null);
  assert.equal(titleFromFileName('e-ticket.pdf'), null);
  assert.equal(titleFromFileName('order 165876208.pdf'), null);
  assert.equal(titleFromFileName('Paradiso.pdf', VENUES), null);
  assert.equal(titleFromFileName(null), null);
  assert.equal(
    titleFromFileName('The Afghan Whigs - order 165876208.pdf'),
    'The Afghan Whigs'
  );
});
