import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://www.bret.bar/club', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(5000);
for (let i = 0; i < 4; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i+1)/4})`);
  await page.waitForTimeout(800);
}
const data = (await page.evaluate(`(() => {
  // Find any visible event-data
  const allText = document.body.innerHTML;
  const dates = (allText.match(/\\d{1,2}\\s+(?:jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)\\w*/gi) || []).slice(0, 10);
  const links = Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h => h && h.includes('event'));
  // Wix events typically rendered with data-hook="event-card"
  const cards = Array.from(document.querySelectorAll('[data-hook*="event"], [data-hook*="card"], [class*="event-card"]'));
  return {
    dates: Array.from(new Set(dates)).slice(0, 15),
    links: Array.from(new Set(links)).slice(0, 10),
    cardCount: cards.length,
    cardSample: cards[0] ? cards[0].outerHTML.slice(0, 600) : 'no cards',
  };
})()`)) as any;
console.log('dates:', data.dates);
console.log('event links:', data.links);
console.log('cards:', data.cardCount);
console.log('first card:', data.cardSample);
await browser.close();
process.exit(0);
