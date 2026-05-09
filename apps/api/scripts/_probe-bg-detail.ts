import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const apis: Array<{ method: string; url: string; status?: number; bodyPreview?: string }> = [];
page.on('response', async (res) => {
  const u = res.url();
  if (
    u.includes('brakkegrond') &&
    !u.match(/\.(?:css|svg|woff2?|ttf|png|jpe?g|gif|ico|webp|mp4|mp3|js)$/) &&
    !u.includes('googletag') && !u.includes('analytics')
  ) {
    try {
      const text = await res.text();
      apis.push({ method: res.request().method(), url: u, status: res.status(), bodyPreview: text.slice(0, 800) });
    } catch {}
  }
});
await page.goto('https://brakkegrond.nl/agenda/781/ntgentluanda-casella-pablo-casella', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
// Trigger lazy-loaded content
for (let i = 0; i < 6; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${i / 5})`);
  await page.waitForTimeout(500);
}
await page.evaluate(`window.scrollTo(0, 0)`);
await page.waitForTimeout(1000);

console.log(`-- ${apis.length} non-asset responses --\n`);
for (const a of apis.slice(0, 12)) {
  console.log(`${a.method} ${a.status} ${a.url.slice(0, 130)}`);
  if (a.bodyPreview && (a.bodyPreview.startsWith('{') || a.bodyPreview.startsWith('['))) {
    console.log('  body:', a.bodyPreview.slice(0, 400));
  }
  console.log();
}

// After render: extract dates + image + description
const data = (await page.evaluate(`(() => {
  const og = {};
  for (const m of document.querySelectorAll('meta[property^="og:"]')) {
    og[m.getAttribute('property')] = m.getAttribute('content');
  }
  // Datums
  const html = document.body.innerHTML;
  const iso = (html.match(/\\b202[6-9]-\\d{2}-\\d{2}/g) || []).slice(0, 10);
  const dutch = (html.match(/\\b\\d{1,2}\\s+(?:jan|feb|mrt|maart|apr|mei|jun|jul|aug|sep|okt|nov|dec)\\w*/gi) || []).slice(0, 10);
  // Body content
  const main = document.querySelector('main, article, [class*="event"], [class*="content"]');
  const bodyText = main ? (main.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1500) : '';
  // First image: walk all imgs and srcsets + data-src + lazy attrs
  const imgs = Array.from(document.querySelectorAll('img'));
  const imgCandidates = imgs.map(i => ({
    cls: ((i).className || '').slice(0, 40),
    src: (i).src || '',
    dataSrc: (i).getAttribute('data-src') || '',
    srcset: (i).srcset || '',
    dataSrcset: (i).getAttribute('data-srcset') || '',
  })).filter(x => (x.src && !/logo|sprite|icon|data:,/i.test(x.src)) || x.dataSrc || x.srcset || x.dataSrcset).slice(0, 5);
  const imgSrc = imgCandidates[0]?.src || imgCandidates[0]?.dataSrc || '';
  const bg = Array.from(document.querySelectorAll('[style*="background-image"]')).slice(0, 3).map(e => (e.getAttribute('style')||'').match(/url\\(["']?([^"')]+)/)?.[1] || '').filter(Boolean);
  // Sample all sections
  const sections = Array.from(document.querySelectorAll('section, article, [class*="block"]')).slice(0, 8).map((s) => ({
    cls: ((s).className || '').slice(0, 60),
    textLen: ((s).textContent || '').length,
    sample: ((s).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
  }));
  // h1
  const h1 = document.querySelector('h1');
  const h1Text = h1 ? (h1.textContent || '').trim() : '';
  // Probe gallery-block__image specifically
  const galleryEl = document.querySelector('.gallery-block__image, .gallery-block__item-image');
  const galleryHtml = galleryEl ? galleryEl.outerHTML.slice(0, 800) : '';
  return { og, iso: Array.from(new Set(iso)), dutch: Array.from(new Set(dutch)), bodyText, imgSrc, bg, sections, h1Text, imgCandidates, galleryHtml };
})()`)) as any;
console.log('og:', data.og);
console.log('iso-dates:', data.iso);
console.log('dutch dates:', data.dutch);
console.log('img:', data.imgSrc);
console.log('bg:', data.bg);
console.log('galleryHtml:', data.galleryHtml);
console.log('h1:', data.h1Text);
console.log('sections:');
for (const s of data.sections ?? []) console.log(`  cls=${s.cls} | len=${s.textLen} | "${s.sample}"`);
console.log('body:', data.bodyText.slice(0, 800));

await browser.close();
process.exit(0);
