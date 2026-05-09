import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto('https://www.ot301.nl/nl/agenda', { waitUntil: 'networkidle', timeout: 30000 });

// Get the structure: how are day-headers + events linked?
const data = (await page.evaluate(`(() => {
  // Find the agenda container
  const container = document.querySelector('.agenda') || document.querySelector('[class*="agenda"]');
  if (!container) return { found: false };
  // Walk children looking for day-headers + events
  const children = Array.from(container.children);
  const out = children.slice(0, 30).map(c => ({
    tag: c.tagName,
    cls: (c.className || '').split(' ').slice(0, 3).join('.'),
    text: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  }));
  return { found: true, container: container.tagName + '.' + (container.className||'').split(' ').slice(0,2).join('.'), children: out };
})()`)) as { found: boolean; container?: string; children?: Array<{tag:string;cls:string;text:string}> };

console.log('container:', data.container);
console.log(`children (${data.children?.length}):`);
for (const c of data.children ?? []) console.log(' ', c.tag.padEnd(5), c.cls.padEnd(30), '|', c.text.slice(0,80));

// Try a different walk — go through every direct text node + a pattern
const dayInfo = (await page.evaluate(`(() => {
  const all = document.querySelectorAll('*');
  const out = [];
  for (const el of all) {
    const t = (el.textContent || '').trim();
    // Match "Zaterdag 09 Mei" pattern at start
    if (/^(Maandag|Dinsdag|Woensdag|Donderdag|Vrijdag|Zaterdag|Zondag)\\s+\\d{1,2}\\s+(Jan|Feb|Maa|Apr|Mei|Jun|Jul|Aug|Sep|Okt|Nov|Dec)/.test(t) && t.length < 50 && el.children.length === 0) {
      out.push({ tag: el.tagName, cls: (el.className||'').slice(0,30), text: t.slice(0,40) });
    }
    if (out.length >= 8) break;
  }
  return out;
})()`)) as Array<{tag:string;cls:string;text:string}>;
console.log('\nday-header candidates:');
for (const d of dayInfo) console.log(' ', d);

await browser.close();
process.exit(0);
