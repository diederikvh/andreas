const UA = 'Mozilla/5.0 (Andreas/1.0)';
for (const u of ['https://brakkegrond.nl/agenda',
                 'https://brakkegrond.nl/agenda/930/zuidpool',
                 'https://brakkegrond.nl/agenda/922/wayward-sanctuaries']) {
  const r = await fetch(u, { headers: { 'user-agent': UA, 'accept-language': 'nl-NL' }, signal: AbortSignal.timeout(30000) });
  const h = await r.text();
  const tel = (re: RegExp) => (h.match(re) ?? []).length;
  console.log(`${u.replace('https://brakkegrond.nl','')}  HTTP ${r.status}  ${h.length}b`);
  console.log(`   card-default__category=${tel(/card-default__category/g)}  agenda-link=${tel(/href="[^"]*\/agenda\/\d+\/[a-z]/g)}`);
  console.log(`   tickets-date=${tel(/event-detail__tickets-date/g)}  tickets-info=${tel(/event-detail__tickets-info/g)}  h1=${tel(/<h1/g)}  text-block=${tel(/text-block/g)}`);
}
process.exit(0);
