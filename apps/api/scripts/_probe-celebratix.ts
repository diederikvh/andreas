import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('celebratix') && !u.match(/\.(?:css|js|png|svg|woff|jpe?g)$/)) {
    try {
      const b = await res.text();
      apis.push({ url: u, status: res.status(), body: b.slice(0, 500) });
    } catch {}
  }
});
await page.goto(
  'https://www-bret-bar.filesusr.com/html/327b25_3df2433a2c6e75717c5fe7592c9853b2.html',
  { waitUntil: 'networkidle', timeout: 30000 }
);
await page.waitForTimeout(5000);
console.log(`-- ${apis.length} Celebratix responses --`);
for (const a of apis.slice(0, 10)) {
  console.log(`\n${a.status} ${a.url.slice(0, 130)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log(' body:', a.body.slice(0, 400));
}

// Also check rendered DOM
const data = (await page.evaluate(`(() => {
  const html = document.body.innerHTML;
  const dates = (html.match(/\\d{1,2}\\s+\\w{3,}/g) || []).slice(0, 8);
  const links = Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h && (h.includes('event') || h.includes('ticket')));
  const titles = Array.from(document.querySelectorAll('h1, h2, h3, [class*="title"]')).map(e => (e.textContent||'').trim()).filter(t => t && t.length > 3 && t.length < 80);
  return { dates: Array.from(new Set(dates)), links: Array.from(new Set(links)).slice(0, 8), titles: titles.slice(0, 8) };
})()`)) as any;
console.log('\n-- DOM after render --');
console.log('titles:', data.titles);
console.log('dates:', data.dates);
console.log('links:', data.links);

await browser.close();
process.exit(0);
