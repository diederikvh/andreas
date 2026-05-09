import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://thuishaven.nl', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(3000);
for (let i = 0; i < 4; i++) {
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight * ${(i+1)/4})`);
  await page.waitForTimeout(700);
}
const data = (await page.evaluate(`(() => {
  const html = document.body.innerHTML;
  const dates = (html.match(/\\d{1,2}\\s+(?:jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec)\\w*/gi) || []).slice(0, 10);
  // event-link patterns
  const links = Array.from(new Set(Array.from(document.querySelectorAll('a')).map(a => a.href).filter(h =>
    h && (h.includes('/event') || h.includes('/product') || h.includes('thuishaven')) && !h.includes('logo')
  ))).slice(0, 20);
  // find tickets-CTA
  const cta = Array.from(document.querySelectorAll('a, button')).filter(el => /ticket|kaart|kopen|tickets/i.test(el.textContent || '')).slice(0, 5).map(e => ({
    tag: e.tagName, text: (e.textContent||'').trim().slice(0, 40), href: (e).href || ''
  }));
  // Look for h2/h3 in agenda
  const agendaEl = document.getElementById('agenda') || document.querySelector('[id*="agenda"], [class*="agenda"]');
  const agendaText = agendaEl ? (agendaEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000) : '';
  return { dates: Array.from(new Set(dates)), links, cta, agendaText };
})()`)) as any;
console.log('dates:', data.dates);
console.log('agenda text (1000):', data.agendaText);
console.log('CTAs:');
for (const c of data.cta ?? []) console.log(' ', c);
console.log('event-links:');
for (const l of data.links ?? []) console.log(' ', l.slice(0, 130));
await browser.close();
process.exit(0);
