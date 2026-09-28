import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test@localhost/test';
const { normalTitle } = await import('./titles.js');

test('titels in normale schrijfwijze, stilering en afkortingen blijven', () => {
  assert.equal(normalTitle('ELMER'), 'Elmer');
  assert.equal(normalTitle('HET GOEDE DOEL®', 'Het Goede Doel'), 'Het Goede Doel');
  assert.equal(normalTitle('Het Goede Doel®'), 'Het Goede Doel');
  assert.equal(normalTitle('NUBIYAN TWIST', 'Nubiyan Twist'), 'Nubiyan Twist');
  assert.equal(normalTitle('FKJ', 'FKJ'), 'FKJ');
  assert.equal(normalTitle('BUNT.', 'BUNT.'), 'BUNT.');
  assert.equal(normalTitle('ADE | CODA'), 'ADE | Coda');
  assert.equal(normalTitle('NDSM OPEN'), 'NDSM Open');
  assert.equal(normalTitle('ALLES VOOR HET EXPERIMENT'), 'Alles voor het Experiment');
  assert.equal(normalTitle('DE JOHNSONS'), 'De Johnsons');
  assert.equal(normalTitle('SBP4'), 'SBP4');
  assert.equal(normalTitle('NO BARRIER'), 'No Barrier');
  assert.equal(normalTitle('JON ALLEN & THE LUNA KINGS'), 'Jon Allen & the Luna Kings');
  assert.equal(normalTitle('HACKEDEPICIOTTO (DE) + GLICE'), 'Hackedepiciotto (DE) + Glice');
  assert.equal(normalTitle('DAYCARE - BASTIENNE B2B SHALEEN - ADE'), 'Daycare - Bastienne B2B Shaleen - ADE');
  assert.equal(normalTitle('bdrmm'), 'bdrmm');
  assert.equal(normalTitle('CMAT + support'), 'CMAT + support');
});
