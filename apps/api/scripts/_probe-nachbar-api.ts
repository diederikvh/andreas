import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ method: string; url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('stager') && !u.match(/\.(?:js|css|png|svg|woff|jpe?g|gif|ico|webp|woff2|ttf)$/) && !u.includes('public/')) {
    try {
      const b = await res.text();
      apis.push({ method: res.request().method(), url: u, status: res.status(), body: b.slice(0, 600) });
    } catch {}
  }
});
await page.goto('https://nachbar.stager.co/shop/nachbar', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
console.log(`-- ${apis.length} API responses --`);
for (const a of apis.slice(0, 15)) {
  console.log(`\n${a.method} ${a.status} ${a.url.slice(0, 150)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log(' body:', a.body.slice(0, 350));
}
await browser.close();
process.exit(0);
