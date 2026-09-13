import { chromium } from 'playwright';
import { parseQfactoryTiles } from '../src/scrapers/_qfactory-agenda.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const URL = 'https://q-factory.com/nl#all-events-section';
const EVAL = `(() => {
  const section = document.getElementById('all-events-section');
  if (!section) return [];
  const all = Array.from(section.querySelectorAll('div.cursor-pointer'));
  const out = [];
  for (const tile of all) {
    const img = tile.querySelector('img');
    if (!img) continue;
    const spans = Array.from(tile.querySelectorAll('span')).map(s => (s.textContent || '').trim()).filter(Boolean);
    const dateSpan = spans.find(s => /^(Ma|Di|Wo|Do|Vr|Za|Zo)\\.\\d{1,2}\\./.test(s));
    if (!dateSpan) continue;
    const heading = tile.querySelector('h1, h2, h3, [id^="SH"]');
    const title = heading ? (heading.textContent || '').trim() : '';
    const fullText = (tile.textContent || '').replace(/\\s+/g, ' ').trim();
    let description = '';
    const titleIdx = fullText.indexOf(title);
    if (titleIdx >= 0 && title) description = fullText.slice(titleIdx + title.length).trim();
    const lastSpans = spans.slice(-6);
    const knownRooms = ['Grote Zaal', 'Q-Cafe', 'Loungezaal', 'Foyer', 'Kleine Zaal'];
    const room = lastSpans.find(s => knownRooms.includes(s)) || '';
    const tags = lastSpans.filter(s => !/^(Ma|Di|Wo|Do|Vr|Za|Zo)\\./.test(s) && s !== title && s !== room && s.length < 40 && !/keert terug|terug|tijdens/i.test(s));
    out.push({ date: dateSpan, title, description: description.replace(room, '').trim().slice(0, 600), room, tags: Array.from(new Set(tags)).slice(0, 5), imageUrl: img.src || '' });
  }
  return out;
})()`;

const browser = await chromium.launch();
const c = await browser.newContext({ userAgent: UA });
const p = await c.newPage();
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForTimeout(2500);
for (let i = 0; i < 4; i++) { await p.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i + 1) / 4})`); await p.waitForTimeout(500); }
const pw = (await p.evaluate(EVAL)) as any[];
await browser.close();

const r = await fetch('https://q-factory.com/nl', { headers: { 'user-agent': UA, 'accept-language': 'nl-NL' } });
const http = parseQfactoryTiles(await r.text());

console.log(`playwright ${pw.length} tegels, http ${http.length} tegels\n`);
const velden = ['date', 'title', 'room', 'imageUrl', 'description', 'tags'] as const;
let gelijk = 0, totaal = 0;
for (let i = 0; i < Math.max(pw.length, http.length); i++) {
  const a: any = pw[i] ?? {}, b: any = http[i] ?? {};
  for (const v of velden) {
    totaal++;
    const x = JSON.stringify(a[v] ?? null), y = JSON.stringify(b[v] ?? null);
    if (x === y) { gelijk++; continue; }
    console.log(`tegel ${i} ${v}:\n   pw   ${x.slice(0, 150)}\n   http ${y.slice(0, 150)}`);
  }
}
console.log(`\n${gelijk}/${totaal} veldwaarden gelijk`);
process.exit(0);
