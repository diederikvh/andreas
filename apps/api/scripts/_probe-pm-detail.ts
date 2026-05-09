import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: string[] = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('podiummozaiek') && (u.includes('/api/') || u.includes('graphql') || u.includes('.json'))) {
    apis.push(`${res.status()} ${u}`);
  }
});
await page.goto(
  'https://www.podiummozaiek.nl/programma/details/tm-11869-915fb9d5/expositie-klimaatverandering-in-nederland',
  { waitUntil: 'networkidle', timeout: 30000 }
);
await page.waitForTimeout(3000);

console.log(`api calls: ${apis.length}`);
for (const a of apis.slice(0, 8)) console.log(' ', a);

const data = (await page.evaluate(`(() => {
  const og = {};
  for (const m of document.querySelectorAll('meta[property^="og:"]')) {
    og[m.getAttribute('property')] = m.getAttribute('content');
  }
  // Find first article-like content
  const article = document.querySelector('article, main, [class*="content"], [class*="detail"]');
  const text = article ? (article.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600) : '';
  // First image
  const img = document.querySelector('img[src*="upload"], img[src*="cdn"], picture img');
  const imgUrl = img ? img.src : '';
  // h1
  const h1 = document.querySelector('h1');
  return { og, h1: h1 ? (h1.textContent||'').trim() : '', img: imgUrl, text: text };
})()`)) as any;
console.log('\nh1:', data.h1);
console.log('og:', data.og);
console.log('img:', data.img);
console.log('text:', data.text.slice(0, 300));

await browser.close();
process.exit(0);
