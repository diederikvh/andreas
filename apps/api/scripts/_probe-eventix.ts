import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ url: string; status: number; body: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('eventix') && (u.includes('/api/') || u.includes('graphql') || u.includes('.json'))) {
    try {
      const b = await res.text();
      apis.push({ url: u, status: res.status(), body: b.slice(0, 600) });
    } catch {}
  }
});
await page.goto('https://shop.eventix.io/74cd4017-dd5a-43d5-8f4a-1b1a53e07ec7', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
console.log(`-- ${apis.length} API responses --`);
for (const a of apis.slice(0, 12)) {
  console.log(`\n${a.status} ${a.url.slice(0, 130)}`);
  if (a.body && (a.body.startsWith('{') || a.body.startsWith('['))) console.log('  body:', a.body.slice(0, 400));
}
await browser.close();
process.exit(0);
