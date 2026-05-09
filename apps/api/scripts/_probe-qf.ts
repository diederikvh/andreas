import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://q-factory.com/nl#all-events-section', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);
for (let i = 0; i < 6; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i+1)/6})`);
  await page.waitForTimeout(500);
}
const data = (await page.evaluate(`(() => {
  const section = document.getElementById('all-events-section');
  if (!section) return { found: false };
  // What is INSIDE the section?
  const directChildren = Array.from(section.children).slice(0, 5).map(c => ({
    tag: c.tagName, cls: (c.className||'').slice(0,80), childCount: c.children.length, text: (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 120),
  }));
  // Find any anchor with href starting with /
  const anchors = Array.from(section.querySelectorAll('a')).slice(0, 10);
  const aSamples = anchors.map(a => ({ href: (a).href, text: ((a).textContent||'').trim().slice(0, 60) }));
  // Find any image
  const imgs = Array.from(section.querySelectorAll('img')).slice(0, 5);
  const iSamples = imgs.map(i => ({ src: (i).currentSrc || (i).src, alt: (i).alt }));
  // Find tile-like containers (have an image)
  const tilesWithImg = Array.from(section.querySelectorAll('div, article, li')).filter(el => (el).querySelector('img'));
  const tileSamples = tilesWithImg.slice(0, 3).map(el => ({
    cls: ((el).className||'').slice(0,80),
    childCount: (el).children.length,
    text: ((el).textContent||'').replace(/\\s+/g,' ').trim().slice(0, 250),
    imgSrc: ((el).querySelector('img')||{}).src || '',
    innerHtml: (el).innerHTML.slice(0, 600),
  }));
  return { found: true, directChildren, anchors: aSamples, imgs: iSamples, tiles: tileSamples };
})()`)) as any;
console.log(JSON.stringify(data, null, 2));
await browser.close();
process.exit(0);
