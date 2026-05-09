import { chromium } from 'playwright';

const browser = await chromium.launch();

async function probe(name: string, url: string) {
  console.log(`\n========== ${name} (${url}) ==========`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const apis: string[] = [];
  page.on('request', (req) => {
    const u = req.url();
    if ((u.includes('/api/') || u.includes('graphql') || u.includes('eventix') || u.includes('weeztix') || u.includes('.json')) && !u.includes('googletag') && !u.includes('google-analytics')) {
      apis.push(`${req.method()} ${u}`);
    }
  });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log('  goto err:', (e as Error).message.slice(0, 80));
  }
  await page.waitForTimeout(2000);

  // Try infinite-scroll
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
    await page.waitForTimeout(800);
    const c = (await page.evaluate(`document.body.scrollHeight`)) as number;
    if (c === prev) break;
    prev = c;
  }

  const linkSamples = (await page.evaluate(`(() => {
    const all = Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h && !h.startsWith('javascript:'));
    const seen = new Set();
    const out = [];
    for (const h of all) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
      if (out.length >= 30) break;
    }
    return out;
  })()`)) as string[];

  // Look for date patterns in DOM
  const dateInfo = (await page.evaluate(`(() => {
    const html = document.body.innerHTML;
    const iso = (html.match(/202[6-9]-\\d{2}-\\d{2}/g) || []).slice(0, 5);
    const dutch = (html.match(/\\d{1,2}\\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/gi) || []).slice(0, 5);
    const dataDate = (html.match(/data-date="[^"]+"/g) || []).slice(0, 3);
    return { iso: iso, dutch: dutch, dataDate: dataDate };
  })()`)) as { iso: string[]; dutch: string[]; dataDate: string[] };

  // Sample event-link patterns
  const eventLikeLinks = linkSamples.filter((l) =>
    /\/(?:agenda|programma|events?|shows?|voorstelling|productie|nl)\/[a-z][\w-]+/.test(l)
  ).slice(0, 6);

  console.log(`  api/json calls: ${apis.length}`);
  for (const a of apis.slice(0, 6)) console.log('   ', a.slice(0, 130));
  console.log(`  iso-dates in DOM: ${dateInfo.iso.length} (samples: ${dateInfo.iso.slice(0,3).join(', ')})`);
  console.log(`  dutch-dates: ${dateInfo.dutch.length} (samples: ${dateInfo.dutch.slice(0,3).join(', ')})`);
  console.log(`  data-date attrs: ${dateInfo.dataDate.length}`);
  console.log(`  event-like links: ${eventLikeLinks.length}`);
  for (const l of eventLikeLinks.slice(0, 4)) console.log('   ', l.slice(0, 120));

  await ctx.close();
}

await probe('Sugarfactory', 'https://www.sugarfactory.nl/');
await probe('Sugarfactory /agenda', 'https://www.sugarfactory.nl/agenda/');
await probe('Sugarfactory /events', 'https://www.sugarfactory.nl/events/');
await probe('OT301 /agenda', 'https://www.ot301.nl/agenda');
await probe('OT301 /agenda alt', 'https://www.ot301.nl/nl/agenda');

await browser.close();
process.exit(0);
