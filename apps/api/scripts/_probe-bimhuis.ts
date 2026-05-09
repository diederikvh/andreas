import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Capture all API/network calls
const apiCalls: string[] = [];
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('bimhuis') || u.includes('graphql') || u.includes('/api/') || u.includes('.json')) {
    apiCalls.push(`${req.method()} ${u}`);
  }
});

await page.goto('https://www.bimhuis.nl/en/calendar/', { waitUntil: 'networkidle', timeout: 30000 });

// Look for month-navigation or date-filter elements
const navInfo = await page.evaluate(() => {
  const selects = Array.from(document.querySelectorAll('select')).map((s) => ({
    name: s.name || s.id,
    options: Array.from(s.options).slice(0, 5).map((o) => o.value),
  }));
  const links = Array.from(document.querySelectorAll('a, button')).filter((el) => {
    const t = (el.textContent ?? '').toLowerCase();
    return /next|volgende|maand|month|juni|june|july|juli/.test(t) && t.length < 30;
  }).slice(0, 5).map((el) => ({
    text: el.textContent?.trim().slice(0, 40),
    href: (el as HTMLAnchorElement).href,
    className: (el as HTMLElement).className?.slice(0, 50),
  }));
  return { selects, links };
});
console.log('nav-info:', JSON.stringify(navInfo, null, 2));
console.log('\napi-calls captured:');
for (const c of apiCalls) console.log('  ' + c);
console.log('');

// Initial count
let count = await page.$$eval('time.agenda-tile__dates', (els) => els.length);
console.log(`initial events: ${count}`);

// Try infinite scroll
let prev = -1;
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const newCount = await page.$$eval('time.agenda-tile__dates', (els) => els.length);
  if (newCount === prev) {
    console.log(`scroll iter ${i}: ${newCount} (stable, stop)`);
    break;
  }
  console.log(`scroll iter ${i}: ${newCount} events`);
  prev = newCount;
}
count = prev > 0 ? prev : count;

// Try load-more (probe for button)
const loadMoreSelector = await page.evaluate(() => {
  const candidates = [
    'button[data-testid*="load"]',
    'button[class*="load-more"]',
    'button[class*="loadMore"]',
    'a[class*="load-more"]',
    'button[aria-label*="more"]',
    'button[aria-label*="meer"]',
  ];
  for (const sel of candidates) {
    if (document.querySelector(sel)) return sel;
  }
  // fallback: any button with "more" / "meer" / "load" text
  const btns = Array.from(document.querySelectorAll('button, a'));
  for (const b of btns) {
    const t = (b.textContent ?? '').toLowerCase().trim();
    if (/more|meer|laad|load/.test(t) && t.length < 30) {
      return `${b.tagName.toLowerCase()}.${(b as HTMLElement).className?.split(' ')[0] ?? ''}`;
    }
  }
  return null;
});
console.log(`load-more selector: ${loadMoreSelector}`);

// Try clicking load-more 5x and measure growth
if (loadMoreSelector) {
  for (let i = 0; i < 10; i++) {
    const btn = await page.$(loadMoreSelector);
    if (!btn) {
      console.log(`iter ${i}: button gone`);
      break;
    }
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      console.log(`iter ${i}: not visible`);
      break;
    }
    await btn.click().catch(() => {});
    await page.waitForTimeout(800);
    const newCount = await page.$$eval('time.agenda-tile__dates', (els) => els.length);
    console.log(`iter ${i}: ${newCount} events (${newCount - count} new)`);
    if (newCount === count) {
      console.log(`stopped growing after ${i} iters`);
      break;
    }
    count = newCount;
  }
}

// Final extraction: walk the tile structure properly
const events = await page.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll('time.agenda-tile__dates'));
  return tiles.map((time) => {
    const date = time.getAttribute('datetime');
    const timeSpan = time.querySelector('span');
    const timeStr = timeSpan?.textContent?.trim() ?? '';
    // Walk up to find the tile container (looking for the link)
    let container: Element | null = time;
    while (container && !container.querySelector('a.agenda-tile__link')) {
      container = container.parentElement;
    }
    const link = container?.querySelector<HTMLAnchorElement>('a.agenda-tile__link');
    const img = container?.querySelector<HTMLImageElement>('img');
    return {
      date,
      timeStr,
      title: link?.querySelector('h3')?.textContent?.trim() ?? '',
      href: link?.href ?? '',
      img: img?.src ?? '',
    };
  });
});
console.log(`extracted ${events.length} events. Sample:`);
console.log(JSON.stringify(events.slice(0, 8), null, 2));
console.log(`\nJohn Scofield duplicates:`,
  events.filter((e) => e.title.includes('Scofield')));

await browser.close();
process.exit(0);
