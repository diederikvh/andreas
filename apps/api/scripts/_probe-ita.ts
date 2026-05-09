import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const apiCalls: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('ita.nl') && (u.includes('/api/') || u.includes('graphql') || u.includes('.json'))) {
    apiCalls.push(`${req.method()} ${u}`);
  }
});

await page.goto('https://ita.nl/nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);

// Try infinite scroll
let prev = -1;
for (let i = 0; i < 20; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.waitForTimeout(1500);
  const c = (await page.evaluate(`document.querySelectorAll('a[href*="voorstellingen"]').length`)) as number;
  if (c === prev) {
    console.log(`scroll iter ${i}: ${c} (stable)`);
    break;
  }
  console.log(`scroll iter ${i}: ${c} voorstellingen-links`);
  prev = c;
}

// Look for filter / load-more
const buttons = (await page.evaluate(`(() => {
  return Array.from(document.querySelectorAll('button, a')).filter(el => {
    const t = (el.textContent || '').toLowerCase();
    return /more|meer|toon|laad|volgende|next/.test(t) && t.length < 30;
  }).map(el => ({ text: (el.textContent || '').slice(0, 30).trim(), tag: el.tagName }));
})()`)) as Array<{ text: string; tag: string }>;
console.log('candidate buttons:', buttons.slice(0, 5));

console.log('\napi-calls:', apiCalls.length);
for (const c of apiCalls.slice(0, 10)) console.log(' ', c);
console.log('');

const links = (await page.evaluate(`(() => {
  const anchors = Array.from(document.querySelectorAll('a'));
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const href = a.href;
    if (!href || !href.includes('voorstellingen')) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const txt = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    out.push({ href, text: txt });
  }
  return out;
})()`)) as Array<{ href: string; text: string }>;

console.log(`voorstelling-links: ${links.length}`);
for (const l of links.slice(0, 8)) console.log(' ', l.href.slice(0, 100), '|', l.text.slice(0, 50));

const html = await page.content();
console.log('\nHTML size:', html.length);

await browser.close();
process.exit(0);
