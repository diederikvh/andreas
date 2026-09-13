import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAgendaCards } from './_muziekgebouw-agenda.js';

/** Nagebouwd naar de echte markup van muziekgebouw.nl/nl/agenda. */
const KAART = `
<li data-entry-id="15771" class=" eventCard context-default variant-normal topdate " data-controller="genres">
 <div class="listItemWrapper "><div class="thumb xl">
  <a class="image" href="/nl/agenda/groove-beest-rb5q" tabindex="-1"><picture class="responsive-image">
   <source media="(min-width: 768px)" srcset="https://img.muziekgebouw.nl/BREED/x.jpg" />
   <img src="https://img.muziekgebouw.nl/GOED/x.jpg" alt="Groove Beest &copy; Isaac Owusu" />
  </picture></a></div>
  <div class="inner"><div class="descMetaContainer">
   <a class="desc" href="/nl/agenda/groove-beest-rb5q">
    <h3 class="title">Groove Beest</h3>
    <div class="subtitle">The Soul of Gospel</div>
    <div class="top-date"><span class="start"> zo 13 sep 2026 </span><span class="time"> 13:30 </span></div>
    <div class="tagline"><p>Een interactieve gospeljam vol energie, ritme &amp; plezier</p></div>
    <div class="venue"> Bimhuis </div>
   </a>
  </div></div></div>
</li>`;

const KAART_KAAL = `
<li data-entry-id="15772" class=" eventCard variant-normal ">
 <div class="thumb"><a class="image" href="/nl/agenda/stil-abcd"><img src="https://img.muziekgebouw.nl/B/y.jpg" alt="" /></a></div>
 <a class="desc" href="/nl/agenda/stil-abcd">
  <h3 class="title">Stil</h3>
  <div class="subtitle"></div>
  <div class="top-date"><span class="start"> ma 14 sep 2026 </span></div>
 </a>
</li>`;

const pagina = (kaarten: string, next = true) => `<html><body>
 <h2 class="title">Agenda</h2>
 <ul class="eventList">${kaarten}</ul>
 ${next ? `<a class="btn next" href="/nl/agenda?page=2">Volgende</a>` : ''}
</body></html>`;

test('leest alle velden van een volle kaart', () => {
  const { cards } = parseAgendaCards(pagina(KAART));
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    title: 'Groove Beest',
    subtitle: 'The Soul of Gospel',
    dateText: 'zo 13 sep 2026',
    timeText: '13:30',
    room: 'Bimhuis',
    tagline: 'Een interactieve gospeljam vol energie, ritme & plezier',
    href: '/nl/agenda/groove-beest-rb5q',
    imageUrl: 'https://img.muziekgebouw.nl/GOED/x.jpg',
  });
});

test('pakt de img en niet de srcset van <source>', () => {
  const { cards } = parseAgendaCards(pagina(KAART));
  assert.ok(!cards[0]!.imageUrl!.includes('BREED'));
});

test('ontbrekende velden worden null, niet leeg', () => {
  const { cards } = parseAgendaCards(pagina(KAART_KAAL));
  assert.equal(cards[0]!.title, 'Stil');
  assert.equal(cards[0]!.timeText, null);
  assert.equal(cards[0]!.room, null);
  assert.equal(cards[0]!.subtitle, null);
});

test('velden lekken niet van de ene kaart naar de andere', () => {
  // Zonder scoping zou "Stil" de zaal en tijd van Groove Beest erven.
  const { cards } = parseAgendaCards(pagina(KAART + KAART_KAAL));
  assert.equal(cards.length, 2);
  assert.equal(cards[1]!.title, 'Stil');
  assert.equal(cards[1]!.room, null);
  assert.equal(cards[1]!.timeText, null);
  assert.equal(cards[1]!.href, '/nl/agenda/stil-abcd');
});

test('de h2.title buiten de kaarten telt niet mee', () => {
  const { cards } = parseAgendaCards(pagina(KAART));
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.title, 'Groove Beest');
});

test('volgende-knop bepaalt hasNext', () => {
  assert.equal(parseAgendaCards(pagina(KAART, true)).hasNext, true);
  assert.equal(parseAgendaCards(pagina(KAART, false)).hasNext, false);
});

test('pagina zonder kaarten geeft een lege lijst', () => {
  assert.deepEqual(parseAgendaCards('<html><body>niks</body></html>'), { cards: [], hasNext: false });
});
