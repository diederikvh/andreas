import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

type Capture = { method: string; url: string; status?: number; bodyPreview?: string };
const captures: Capture[] = [];

page.on('response', async (res) => {
  const url = res.url();
  if (!url.includes('fareharbor.com/api')) return;
  let bodyPreview = '';
  try {
    const txt = await res.text();
    bodyPreview = txt.slice(0, 600);
  } catch {}
  captures.push({ method: res.request().method(), url, status: res.status(), bodyPreview });
});

await page.goto(
  'https://fareharbor.com/embeds/book/boomchicago/items/575549/calendar/?flow=160086',
  { waitUntil: 'networkidle', timeout: 30000 }
);

await page.waitForTimeout(3000);

console.log(`-- ${captures.length} API responses captured --`);
for (const c of captures) {
  console.log(`\n${c.method} ${c.status} ${c.url}`);
  console.log(`  body[:600]: ${c.bodyPreview}`);
}

const html = await page.content();
const cellMatches = html.match(/data-(?:date|test-date|fh-date)="\d{4}-\d{2}-\d{2}"/g) || [];
console.log(`\n-- data-date matches in DOM: ${cellMatches.length} --`);
console.log('first 5:', cellMatches.slice(0, 5));

await browser.close();
process.exit(0);
