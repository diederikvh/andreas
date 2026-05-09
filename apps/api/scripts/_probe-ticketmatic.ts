import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const apis: Array<{ method: string; url: string; status?: number; body?: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('ticketmatic') && (u.includes('/api/') || u.includes('.json'))) {
    try {
      const text = await res.text();
      apis.push({ method: res.request().method(), url: u, status: res.status(), body: text.slice(0, 800) });
    } catch {}
  }
});
await page.goto('https://ticketshop.ticketmatic.com/podium_mozaiek/shop', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

console.log(`-- ${apis.length} API responses --\n`);
for (const a of apis.slice(0, 8)) {
  console.log(`${a.method} ${a.status} ${a.url}`);
  console.log('  body:', a.body?.slice(0, 400));
  console.log();
}

await browser.close();
process.exit(0);
