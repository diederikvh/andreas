import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ method: string; url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if ((u.includes('openticket') || u.includes('weeztix')) && !u.match(/\.(?:js|css|png|svg|woff|jpe?g|gif|ico|webp)$/) && !u.includes('whitelabels')) {
    try {
      const b = await res.text();
      apis.push({ method: res.request().method(), url: u, status: res.status(), body: b.slice(0, 400) });
    } catch {}
  }
});
await page.goto('https://shop.weeztix.com/0e536f93-e4fd-11ee-a9cb-7e126431635e/events', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(5000);
console.log(`-- ${apis.length} responses (excl. whitelabels.json) --`);
for (const a of apis.slice(0, 15)) {
  console.log(`\n${a.method} ${a.status} ${a.url.slice(0, 150)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log(' body:', a.body.slice(0, 300));
}
await browser.close();
process.exit(0);
