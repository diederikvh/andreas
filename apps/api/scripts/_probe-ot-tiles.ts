import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://www.ot301.nl/nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });
const data = (await page.evaluate(`(() => {
  const tiles = Array.from(document.querySelectorAll('a.event-item'));
  return tiles.slice(0, 5).map(a => {
    const dayWrap = a.closest('.day, .agenda > *') || a.parentElement;
    const otLinks = dayWrap ? Array.from(dayWrap.querySelectorAll('a[href*="/agenda/"]')).map(x => x.getAttribute('href')) : [];
    return {
      href: a.getAttribute('href') || '',
      otLinks: Array.from(new Set(otLinks)),
      title: a.querySelector('h3, h4, h2, strong, span') ? (a.querySelector('h3, h4, h2, strong, span').textContent || '').trim().slice(0, 60) : '',
    };
  });
})()`)) as any[];
for (const d of data) {
  console.log('--- href:', d.href);
  console.log('  ot-links:', d.otLinks);
  console.log('  title:', d.title);
}

// Also: search globally for /agenda/{id} pattern
const allLinks = (await page.evaluate(`(() => {
  return Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/agenda/"]')).map(a => a.getAttribute('href')))).slice(0, 20);
})()`)) as string[];
console.log('\nall /agenda/ hrefs:');
for (const l of allLinks) console.log(' ', l);

await browser.close();
process.exit(0);
