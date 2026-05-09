import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ method: string; url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (!u.match(/\.(?:js|css|png|svg|woff|jpe?g|gif|ico|webp|woff2|ttf)$/) && !u.includes('cdn-cgi') && !u.includes('cf-fonts')) {
    try {
      const b = await res.text();
      apis.push({ method: res.request().method(), url: u, status: res.status(), body: b.slice(0, 400) });
    } catch {}
  }
});
await page.goto('https://web.fourvenues.com/en/iframe/shelter-amsterdam/events?date=2026-05', {
  waitUntil: 'networkidle', timeout: 30000
});
await page.waitForTimeout(4000);
console.log(`-- ${apis.length} fourvenues responses --`);
for (const a of apis.slice(0, 12)) {
  console.log(`\n${a.method} ${a.status} ${a.url.slice(0, 150)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log(' body:', a.body.slice(0, 350));
}
// Look at the rendered DOM in detail
const dom = (await page.evaluate(`(() => {
  // Find event-cards
  const cards = Array.from(document.querySelectorAll('[class*="event-card"], [class*="card"], article, .event'));
  const cardSamples = cards.slice(0, 4).map(c => ({
    cls: ((c).className || '').slice(0, 80),
    text: ((c).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 250),
    img: ((c).querySelector('img') || {}).src || '',
    link: ((c).querySelector('a') || {}).href || '',
  }));
  // Try walk children of main container
  const main = document.querySelector('main, .events, [class*="events"]') || document.body;
  const childSamples = main ? Array.from(main.children).slice(0, 5).map(c => ({
    tag: c.tagName, cls: ((c).className || '').slice(0, 60), childCount: c.children.length,
    text: ((c).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 150),
  })) : [];
  return { cards: cardSamples, children: childSamples };
})()`)) as any;
console.log('\nDOM cards:');
for (const c of dom.cards ?? []) console.log(' ', JSON.stringify(c).slice(0, 250));
console.log('\nDOM main-children:');
for (const c of dom.children ?? []) console.log(' ', JSON.stringify(c));
await browser.close();
process.exit(0);
