import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

type Capture = { method: string; url: string; status?: number; body?: string };
const captures: Capture[] = [];

page.on('request', (req) => {
  const u = req.url();
  if (
    u.includes('cms.concertgebouw') ||
    u.includes('elastic') ||
    u.includes('search') ||
    /\.json/.test(u) ||
    u.includes('graphql')
  ) {
    captures.push({ method: req.method(), url: u, body: req.postData() ?? undefined });
  }
});

page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('cms.concertgebouw') || u.includes('search')) {
    const c = captures.find((c) => c.url === u && !c.status);
    if (c) c.status = res.status();
  }
});

await page.goto('https://www.concertgebouw.nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

console.log(`-- ${captures.length} captures --`);
for (const c of captures) {
  console.log(`${c.method} ${c.status ?? '?'} ${c.url}`);
  if (c.body && c.body.length < 1500) console.log(`  body: ${c.body}`);
}

await browser.close();
process.exit(0);
