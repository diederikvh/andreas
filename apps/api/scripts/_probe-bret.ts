import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  // Wix loads events via wix-engage / wix-events APIs
  if (u.includes('wix') && (u.includes('event') || u.includes('graphql') || u.includes('viewer-data')) && !u.match(/\.(?:js|css|png|jpe?g|svg|woff)$/)) {
    try {
      const b = await res.text();
      apis.push({ url: u, status: res.status(), body: b.slice(0, 500) });
    } catch {}
  }
});
await page.goto('https://www.bret.bar/ticketshop', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
console.log(`-- ${apis.length} wix API responses --`);
for (const a of apis.slice(0, 10)) {
  console.log(`\n${a.status} ${a.url.slice(0, 130)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log('  body:', a.body.slice(0, 350));
}

// Also get DOM events
const events = (await page.evaluate(`(() => {
  const titles = Array.from(document.querySelectorAll('[data-hook*="title"], h2, h3'))
    .map(e => (e.textContent || '').trim())
    .filter(t => t && t.length > 3 && t.length < 80);
  const dates = Array.from(document.querySelectorAll('[data-hook*="date"], time'))
    .map(e => (e.textContent || '').trim())
    .filter(t => t);
  const links = Array.from(document.querySelectorAll('a'))
    .map(a => a.href)
    .filter(h => h && h.includes('event') && !h.includes('static.'));
  return { titles: titles.slice(0,15), dates: dates.slice(0,15), links: Array.from(new Set(links)).slice(0,10) };
})()`)) as any;
console.log('\n-- DOM scrape --');
console.log('titles:', events.titles);
console.log('dates:', events.dates);
console.log('links:', events.links);

await browser.close();
process.exit(0);
