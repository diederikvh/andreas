import assert from 'node:assert/strict';
import { test } from 'node:test';

import { descriptionFromHtml } from './_paradiso-detail.js';

/** Nagebouwd naar de echte pagina: emotion zet z'n CSS in een <style>
    bínnen <main>, en de body staat in een div met een css-hash-klasse
    die per build verandert. */
const pagina = (body: string, staart = '') => `
<html><body><header>Paradiso</header><main>
  <style>.css-1cmozbx ul li:before{top:3px;}.css-1cmozbx ol{list-style-position:inside;} .css-xyz{display:-webkit-box;-webkit-flex-direction:column;background-repeat:no-repeat;}</style>
  <h1>Rostam</h1>
  <div class="css-1cmozbx">${body}</div>
  ${staart}
</main></body></html>`;

const LANG = 'Rostam, voluit Rostam Batmanglij, is een Amerikaanse songwriter en producer van Perzische afkomst en werd bekend als lid van Vampire Weekend.';

test('pakt de body-tekst en niet de emotion-CSS', () => {
  const d = descriptionFromHtml(pagina(`<p>${LANG}</p>`));
  assert.equal(d, LANG);
  assert.ok(!d!.includes('webkit'), 'CSS mag er niet in zitten');
});

test('stopt bij de Line-up-kop', () => {
  const d = descriptionFromHtml(
    pagina(`<p>${LANG}</p><p>Tweede alinea die ook lang genoeg is om mee te tellen in de output.</p>`,
           '<h2>Line-up</h2><p>Deze tekst hoort er niet meer bij en moet wegvallen.</p>')
  );
  assert.ok(d!.includes('Vampire Weekend'));
  assert.ok(d!.includes('Tweede alinea'));
  assert.ok(!d!.includes('hoort er niet meer bij'));
});

test('korte regels vallen weg, lange blijven', () => {
  const d = descriptionFromHtml(pagina(`<p>${LANG}</p><p>Kort.</p>`));
  assert.equal(d, LANG);
});

test('entities worden gedecodeerd', () => {
  const body = '<p>Rock &amp; roll in de Grote Zaal, met een set vol energie en een publiek dat &#039;t helemaal snapt vanaf de eerste noot.</p>';
  const d = descriptionFromHtml(pagina(body));
  assert.ok(d!.includes('Rock & roll'));
  assert.ok(d!.includes("'t helemaal"));
  assert.ok(!d!.includes('&amp;'));
});

test('pagina zonder lange regel geeft null in plaats van rommel', () => {
  assert.equal(descriptionFromHtml(pagina('<p>Kort.</p>')), null);
});

test('pagina zonder main valt terug op de hele HTML', () => {
  const d = descriptionFromHtml(`<html><body><div><p>${LANG}</p></div></body></html>`);
  assert.equal(d, LANG);
});
