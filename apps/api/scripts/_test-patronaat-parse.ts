// Dry-run: alleen card-parsing, geen DB/Claude/Bunny.
import { setTimeout as sleep } from 'node:timers/promises';

const UA = 'Andreas-Scraper/1.0 (+https://andreas.amsterdam)';

const NL_MONTHS: Record<string, number> = {
  jan: 0, januari: 0, feb: 1, februari: 1, mrt: 2, maart: 2,
  apr: 3, april: 3, mei: 4, jun: 5, juni: 5, jul: 6, juli: 6,
  aug: 7, augustus: 7, sep: 8, september: 8, okt: 9, oktober: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').trim();
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const r = await fetch('https://patronaat.nl/programma/', { headers: { 'user-agent': UA } });
const html = await r.text();

const blockRe = /<div class="event-program">([\s\S]*?)(?=<div class="overview__list-item|<\/section|$)/g;
const cards: any[] = [];
for (const m of html.matchAll(blockRe)) {
  const block = m[1];
  const urlMatch = block.match(/<a href="(https:\/\/patronaat\.nl\/event\/([^"\/]+)\/?)"/);
  if (!urlMatch) continue;
  const titleMatch = block.match(/<h3 class="event-program__name">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
  const dateMatch = block.match(/<div class="event-program__date">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
  const subMatch = block.match(/<div class="event-program__subtitle">\s*([\s\S]*?)<\/div>/);
  const imgMatch = block.match(/<img\s[^>]*src="([^"]+)"[^>]*alt="Evenementafbeelding/);
  const genres: string[] = [];
  for (const gm of block.matchAll(/class="event__tags-item event__tags-item--genre"[^>]*>\s*([^<]+)\s*</g)) {
    genres.push(decode(gm[1]).toLowerCase());
  }
  cards.push({
    url: urlMatch[1],
    slug: urlMatch[2],
    title: titleMatch ? decode(stripTags(titleMatch[1])) : null,
    date: dateMatch ? stripTags(dateMatch[1]) : null,
    subtitle: subMatch ? decode(stripTags(subMatch[1])) : null,
    imageUrl: imgMatch ? imgMatch[1] : null,
    genres,
  });
}

console.log('Cards parsed:', cards.length);
console.log('Sample (first 3):');
console.log(JSON.stringify(cards.slice(0, 3), null, 2));
console.log('\nProblems:');
console.log('  no title:', cards.filter(c => !c.title).length);
console.log('  no date:', cards.filter(c => !c.date).length);
console.log('  no image:', cards.filter(c => !c.imageUrl).length);
console.log('  no genres:', cards.filter(c => c.genres.length === 0).length);
