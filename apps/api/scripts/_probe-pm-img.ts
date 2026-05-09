import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(
  'https://www.podiummozaiek.nl/programma/details/tm-11932-9d539288-d144-442a-9fed-ca524de9a167/welcoming-summer',
  { waitUntil: 'domcontentloaded', timeout: 30000 }
);
await page.waitForTimeout(3000);
const imgs = (await page.evaluate(`(() => {
  return Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => s && !s.includes('logo') && !s.startsWith('data:'));
})()`)) as string[];
console.log('imgs:', imgs.slice(0, 5));
await browser.close();
process.exit(0);
