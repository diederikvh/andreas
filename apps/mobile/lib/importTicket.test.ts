/**
 * Ticket-of-poster, op echte tekst. De ticket- en posterfixtures komen uit
 * de OCR-uitkomsten van 11 sep 2026 (zie importMetadata.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectTicket, suggestedIntent } from './importTicket.ts';

/** De ticket-PDF zoals de OCR hem teruggaf. Geen barcode: de PDF had er
    geen, en op iOS zou een streepjescode ook niet gevonden zijn. */
const TICKET_PDF_TEXT = [
  'E-',
  'TICKET',
  'PLOEGENDIENST',
  'support : Library Card',
  'PARADISO',
  'Weterings chans 6-8, Amsterdam',
  'zaterdag 18 oktober 2026',
  'deuren 19:30 - aanvang 20:30',
  'Ticket 4417993-02',
  'Ordernummer 3391827',
].join('\n');

/** Een echte poster: wel een aankondiging, geen kaartje. Inclusief de
    valkuil "Tickets vanaf vrijdag" — dat is verkoopinfo, niet een ticket. */
const POSTER_TEXT = [
  'PLOEGENDIENST',
  'support: Library Card',
  'PARADISO',
  'Amsterdam',
  'zaterdag 18 oktober 2026',
  'deuren 19:30 / aanvang 20:30',
  'Tickets vanaf vrijdag 10:00',
].join('\n');

test('ticket-PDF wordt als ticket herkend, ook zonder barcode', () => {
  const verdict = detectTicket({
    text: TICKET_PDF_TEXT,
    barcodeTypes: [],
    kind: 'pdf',
  });
  assert.equal(verdict.isTicket, true);
  assert.deepEqual(verdict.signals.sort(), [
    'orderNumber',
    'pdf',
    'ticketNumber',
    'ticketWords',
  ]);
  assert.equal(suggestedIntent(verdict, 'pdf'), 'going');
});

test('poster met "Tickets vanaf vrijdag" is geen ticket', () => {
  const verdict = detectTicket({
    text: POSTER_TEXT,
    barcodeTypes: [],
    kind: 'image',
  });
  assert.equal(verdict.isTicket, false);
  assert.deepEqual(verdict.signals, []);
  assert.equal(suggestedIntent(verdict, 'image'), 'save');
});

test('alleen een QR en een stoel is genoeg', () => {
  const verdict = detectTicket({
    text: 'Rij 4 Stoel 12\nDe Roma',
    barcodeTypes: ['qr'],
    kind: 'image',
  });
  assert.equal(verdict.isTicket, true);
  assert.deepEqual(verdict.signals.sort(), ['barcode', 'seat']);
});

test('een poster met alleen een QR haalt de drempel niet', () => {
  // Veel posters hebben een QR naar de ticketshop. Dat mag niet genoeg
  // zijn, anders zet Andreas "Ik ga" op iets wat je nog moet kopen.
  const verdict = detectTicket({
    text: POSTER_TEXT,
    barcodeTypes: ['qr'],
    kind: 'image',
  });
  assert.equal(verdict.score, 0.45);
  assert.equal(verdict.isTicket, false);
});

test('een ticketshop-URL is geen ticket', () => {
  const verdict = detectTicket({
    text: 'https://paradiso.nl/en/program/ticket-shop/12345678',
    barcodeTypes: [],
    kind: 'url',
  });
  // Het woord "ticket" staat er met cijfers achter, maar de slash breekt
  // het nummerpatroon — en dat is precies goed: dit is een winkel, geen
  // kaartje.
  assert.equal(verdict.isTicket, false);
  assert.equal(suggestedIntent(verdict, 'url'), 'save');
});

test('een link blijft "wil ik heen", ook als de tekst wél ticketachtig is', () => {
  const verdict = detectTicket({
    text: 'E-TICKET Ordernummer 3391827 Rij 4 Stoel 12',
    barcodeTypes: ['qr'],
    kind: 'url',
  });
  assert.equal(verdict.isTicket, true);
  // Een gedeelde link is een ontdekking, geen bewijs van een kaartje.
  assert.equal(suggestedIntent(verdict, 'url'), 'save');
});

test('teksten die op een ticket lijken maar het niet zijn', () => {
  for (const text of [
    'Ploegendienst speelt 18 oktober in Paradiso, tickets via de link',
    'nog 2 tickets over voor vrijdag!',
    'Doors open 19:30',
  ]) {
    const verdict = detectTicket({ text, barcodeTypes: [], kind: 'text' });
    assert.equal(verdict.isTicket, false, `"${text}" → ${verdict.score}`);
  }
});
