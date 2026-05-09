import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('weeztix') && (u.includes('/api/') || u.includes('graphql') || u.includes('.json')) && !u.match(/\.(?:js|css|png|svg|woff|jpe?g)$/)) {
    try {
      const b = await res.text();
      apis.push({ url: u, status: res.status(), body: b.slice(0, 400) });
    } catch {}
  }
});
await page.goto('https://shop.weeztix.com/0e536f93-e4fd-11ee-a9cb-7e126431635e/events', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
console.log(`-- ${apis.length} Weeztix responses --`);
for (const a of apis.slice(0, 12)) {
  console.log(`\n${a.status} ${a.url.slice(0, 130)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log(' body:', a.body.slice(0, 350));
}
await browser.close();
process.exit(0);
