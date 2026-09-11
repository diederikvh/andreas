/**
 * Zelfcheck op de privacygrens. Draait op node:test zonder framework —
 * `pnpm --filter @andreas/mobile test`. Deze module importeert bewust
 * niets uit React Native, zodat de check zonder bundler kan lopen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ALLOWED_KEYS, isMatchable, toServerMetadata } from './importPayload.ts';

test('stuurt alleen de zes toegestane velden', () => {
  const out = toServerMetadata({
    title: 'Ploegendienst',
    artists: ['Ploegendienst'],
    venue: 'Paradiso',
    date: '2026-10-18',
    time: '20:00',
    city: 'Amsterdam',
    // Alles hieronder mag het toestel niet verlaten:
    qr: 'https://tickets.example/scan?code=AB12CD34',
    barcode: '9876543210123',
    ticketNumber: 'TK-4417-993',
    orderId: '3391827',
    holderName: 'Diederik van Huijstee',
    ocrText: 'ADMIT ONE\nRIJ 4 STOEL 12\n9876543210123',
    fileUri: 'file:///var/mobile/.../import/ticket.pdf',
  });

  assert.deepEqual(Object.keys(out).sort(), [...ALLOWED_KEYS].sort());
  const serialized = JSON.stringify(out);
  for (const leak of [
    'AB12CD34',
    '9876543210123',
    'TK-4417-993',
    '3391827',
    'Huijstee',
    'ADMIT ONE',
    'file://',
  ]) {
    assert.equal(
      serialized.includes(leak),
      false,
      `${leak} mag niet in de payload zitten`
    );
  }
});

test('gooit een OCR-dump weg in plaats van hem als titel te sturen', () => {
  const out = toServerMetadata({
    title: 'E-TICKET\nPloegendienst\nParadiso\nOrdernummer 3391827',
    venue: 'Paradiso Grote Zaal — rij 4 stoel 12',
    city: 'Amsterdam',
  });
  assert.equal(out.title, null);
  assert.equal(out.venue, null);
  assert.equal(out.city, 'Amsterdam');
  assert.equal(isMatchable(out), false);
});

test('houdt echte postermetadata heel', () => {
  const out = toServerMetadata({
    title: '  PLOEGENDIENST ',
    artists: ['Ploegendienst', 'Library Card', 'Ploegendienst'],
    venue: 'Paradiso',
    date: '2026-10-18',
    time: '8:00',
    city: 'Amsterdam',
  });
  assert.deepEqual(out, {
    title: 'PLOEGENDIENST',
    artists: ['Ploegendienst', 'Library Card'],
    venue: 'Paradiso',
    date: '2026-10-18',
    time: '08:00',
    city: 'Amsterdam',
  });
  assert.equal(isMatchable(out), true);
});

test('weigert half-herkende datum en tijd', () => {
  const out = toServerMetadata({
    title: 'Iets',
    date: '18 oktober 2026',
    time: '20u',
  });
  assert.equal(out.date, null);
  assert.equal(out.time, null);
});
