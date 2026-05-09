import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const apis: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('ot301') && !u.match(/\.(?:css|svg|woff|png|jpe?g|gif|js)$/)) {
    apis.push(`${req.method()} ${u}`);
  }
});
await page.goto('https://www.ot301.nl/nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);

// Scroll to load all
for (let i = 0; i < 10; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
  await page.waitForTimeout(800);
}

// Look at all events on page
const data = (await page.evaluate(`(() => {
  const html = document.body.innerHTML;
  const dutchDates = (html.match(/\\b\\d{1,2}\\s+(?:Jan|Feb|Maa|Apr|Mei|Jun|Jul|Aug|Sep|Okt|Nov|Dec)\\w*\\b/g) || []);
  // event tiles - look for cards
  const cards = Array.from(document.querySelectorAll('article, .event, [class*="event"], [class*="agenda"], [class*="card"]')).slice(0, 5);
  const cardData = cards.map(c => ({
    tagClass: c.tagName + '.' + (c.className || '').split(' ').slice(0, 2).join('.'),
    text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    href: (c.querySelector('a') ? (c.querySelector('a').href) : ''),
  }));
  return { dutchDates: dutchDates.slice(0, 10), cards: cardData };
})()`)) as { dutchDates: string[]; cards: Array<{ tagClass: string; text: string; href: string }> };

console.log('dutch dates:', data.dutchDates);
console.log('\ncards:');
for (const c of data.cards) {
  console.log(`  ${c.tagClass}`);
  console.log(`    text: ${c.text}`);
  console.log(`    href: ${c.href}`);
}

console.log('\napi calls:', apis.length);
for (const a of apis.slice(0, 12)) console.log(' ', a.slice(0, 120));

await browser.close();
process.exit(0);
