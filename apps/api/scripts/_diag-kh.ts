import { chromium } from 'playwright';
import { parseFilmPage, parseFilmUrls } from '../src/scrapers/_ketelhuis-page.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const EVAL = `(() => {
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent ?? '').filter(Boolean);
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? null;
  const titleH1 = document.querySelector('h1')?.textContent?.trim() ?? null;
  const descP = document.querySelector('.single-film p, main p, article p')?.textContent?.trim() ?? null;
  return { blocks, ogImage, titleH1, descP };
})()`;

const browser = await chromium.launch();
const c = await browser.newContext({ userAgent: UA, locale: 'nl-NL' });
const p = await c.newPage();
await p.goto('https://www.ketelhuis.nl/films/', { waitUntil: 'networkidle', timeout: 30000 });
await p.waitForTimeout(1500);
const pwUrls = (await p.evaluate(`(() => [...new Set([...document.querySelectorAll('a[href*="/films/"]')].map(a=>a.getAttribute('href')).filter(h=>h&&/\\/films\\/[^/]+\\/?$/.test(h)))])()`)) as string[];
const rIdx = await fetch('https://www.ketelhuis.nl/films/', { headers: { 'user-agent': UA } });
const httpUrls = parseFilmUrls(await rIdx.text());
console.log(`index: playwright ${pwUrls.length} urls, http ${httpUrls.length} urls`);
const norm = (u: string) => u.replace(/^https?:\/\/www\.ketelhuis\.nl/, '').replace(/\/$/, '');
const a = new Set(pwUrls.map(norm)), b = new Set(httpUrls.map(norm));
console.log(`   alleen in playwright: ${[...a].filter(x=>!b.has(x)).slice(0,4)}`);
console.log(`   alleen in http:       ${[...b].filter(x=>!a.has(x)).slice(0,4)}`);

let gelijk = 0, totaal = 0;
for (const u of pwUrls.slice(0, 5)) {
  const url = u.startsWith('http') ? u : 'https://www.ketelhuis.nl' + u;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForTimeout(800);
  const pw = (await p.evaluate(EVAL)) as any;
  const http = parseFilmPage(await (await fetch(url, { headers: { 'user-agent': UA } })).text());
  for (const v of ['ogImage', 'titleH1', 'descP'] as const) {
    totaal++;
    if ((pw[v] ?? null) === (http[v] ?? null)) gelijk++;
    else console.log(`   ${url.split('/films/')[1]} ${v}:\n      pw   ${JSON.stringify(pw[v])?.slice(0,110)}\n      http ${JSON.stringify(http[v])?.slice(0,110)}`);
  }
  totaal++;
  if (pw.blocks.length === http.blocks.length) gelijk++;
  else console.log(`   ${url.split('/films/')[1]} ld+json blokken: pw=${pw.blocks.length} http=${http.blocks.length}`);
}
await browser.close();
console.log(`\n${gelijk}/${totaal} gelijk over 5 filmpagina's`);
process.exit(0);
