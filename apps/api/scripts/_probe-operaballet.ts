import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('operaballet') && (u.includes('/api/') || u.includes('activit') || u.includes('.json'))) {
    apis.push(`${req.method()} ${u}`);
  }
});
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('operaballet') && (u.includes('/api/') || u.includes('activit'))) {
    try {
      const body = await res.text();
      if (body.length > 50 && body.length < 5000) {
        console.log(`\n[response ${res.status()}] ${u}`);
        console.log(body.slice(0, 1500));
      }
    } catch {}
  }
});
await page.goto(
  'https://www.operaballet.nl/de-nationale-opera/2025-2026/le-nozze-di-figaro',
  { waitUntil: 'networkidle', timeout: 30000 }
);
await page.waitForTimeout(3000);
console.log('\n--- api calls ---');
for (const a of apis) console.log(' ', a);
await browser.close();
process.exit(0);
