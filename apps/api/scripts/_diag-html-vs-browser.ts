/**
 * Kale fetch naast page.content() leggen voor de scrapers die nog een
 * browser gebruiken. Per doel een paar markers die de scraper echt
 * nodig heeft; als die tellingen gelijk zijn kan de browser eruit.
 * Wegwerp-diagnose, niet bedoeld om te blijven staan.
 */
import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

type Doel = { naam: string; url: string; markers: [string, RegExp][]; wacht?: number };

const DOELEN: Doel[] = [
  { naam: 'athenaeum/spui', url: 'https://athenaeumscheltema.nl/agenda-spui',
    markers: [['news-article-link', /<a class="news-article-link"\s+href="\/agenda-spui\//g],
              ['news-article-title', /class="news-article-title"/g]], wacht: 4000 },
  { naam: 'weticket/skatecafe', url: 'https://skatecafe.weticket.io/',
    markers: [['__NEXT_DATA__', /<script id="__NEXT_DATA__"/g]] },
  { naam: 'qfactory', url: 'https://q-factory.com/nl',
    markers: [['div.cursor-pointer', /<div[^>]*class="[^"]*cursor-pointer/g]] },
  { naam: 'bimhuis', url: 'https://www.bimhuis.nl/en/calendar/',
    markers: [['time.agenda-tile__dates', /<time[^>]*class="[^"]*agenda-tile__dates/g]] },
  { naam: 'thuishaven', url: 'https://thuishaven.nl',
    markers: [['agenda-line-up', /agenda-line-up/g], ['a href', /<a\s[^>]*href=/g]] },
  { naam: 'ketelhuis', url: 'https://www.ketelhuis.nl/films/',
    markers: [['/films/-link', /href="[^"]*\/films\/[^"/]+\/?"/g]] },
  { naam: 'thepulse', url: 'https://www.cinemathepulse.com/',
    markers: [['home_shows_item', /home_shows_item/g], ['shows-time-container', /shows-time-container/g]], wacht: 3000 },
  { naam: 'brakkegrond', url: 'https://brakkegrond.nl/agenda',
    markers: [['card-default__category', /card-default__category/g], ['agenda-link', /href="[^"]*\/agenda\/\d+\/[a-z]/g]], wacht: 2500 },
];

const browser = await chromium.launch();
for (const d of DOELEN) {
  let http = '', dom = '';
  try {
    const r = await fetch(d.url, { headers: { 'user-agent': UA, 'accept-language': 'nl-NL' }, signal: AbortSignal.timeout(40000) });
    http = r.ok ? await r.text() : `HTTP ${r.status}`;
  } catch (e) { http = `FOUT ${(e as Error).message}`; }
  const c = await browser.newContext({ userAgent: UA, locale: 'nl-NL' });
  const p = await c.newPage();
  try {
    await p.goto(d.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await p.waitForTimeout(d.wacht ?? 1500);
    dom = await p.content();
  } catch (e) { dom = `FOUT ${(e as Error).message}`; }
  await c.close();

  const tel = (h: string, re: RegExp) => (h.match(new RegExp(re.source, 'g')) ?? []).length;
  const gelijk = d.markers.every(([, re]) => tel(http, re) === tel(dom, re));
  console.log(`\n${gelijk ? '✅' : '⚠️ '} ${d.naam.padEnd(20)} http=${http.length}b  browser=${dom.length}b`);
  for (const [naam, re] of d.markers) {
    const a = tel(http, re), b = tel(dom, re);
    console.log(`     ${naam.padEnd(24)} http=${String(a).padStart(4)}  browser=${String(b).padStart(4)}  ${a === b ? '' : '← VERSCHIL'}`);
  }
}
await browser.close();
process.exit(0);
