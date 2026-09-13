const BASE = 'https://athenaeumscheltema.nl/agenda-spui';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';
const varianten: [string, Record<string, string>][] = [
  ['kaal', {}],
  ['alleen UA', { 'user-agent': UA }],
  ['UA + accept', { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }],
  ['UA + accept + lang', { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8' }],
  ['volledig browser-achtig', {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
  }],
];
for (const [naam, headers] of varianten) {
  try {
    const r = await fetch(BASE, { headers, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    const n = (t.match(/<a class="news-article-link"/g) ?? []).length;
    console.log(`  ${naam.padEnd(24)} HTTP ${r.status}  ${String(t.length).padStart(7)}b  tiles=${n}`);
  } catch (e) { console.log(`  ${naam.padEnd(24)} FOUT ${(e as Error).message.slice(0, 50)}`); }
}
process.exit(0);
