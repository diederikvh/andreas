/**
 * Wat de MCP-tools en de app-routes voor meldingen delen: de leesbare
 * samenvatting van een regel. Eén plek, zodat Claude en het scherm in de
 * app precies hetzelfde zeggen.
 */
import { GENRES, genresOf, mainGenresOf, type Category, type GenreKey } from './genres.js';

const dayFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long' });
const dateLabel = (d: string) => dayFmt.format(new Date(`${d}T12:00:00Z`));
export const cityLabel = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

/** "rock of indie · met "90s" · of Screaming Trees · in Amsterdam" — het
    label dat op de regel komt. */
export function describeAlert(p: {
  genres?: GenreKey[];
  keywords?: string[];
  artists?: string[];
  venues?: string[];
  cities?: string[];
  categories?: string[];
  from?: string;
  to?: string;
  priceMaxEuro?: number;
}): string {
  const parts: string[] = [];
  if (p.categories?.length) parts.push(p.categories.map((c) => c.toLowerCase()).join(' of '));
  if (p.genres?.length) parts.push(p.genres.map((g) => GENRES[g].label).join(' of '));
  if (p.keywords?.length) parts.push(`met ${p.keywords.map((k) => `"${k}"`).join(' of ')}`);
  // Artiesten zijn een alternatief naast genre en trefwoord (zie ALERT_MATCH).
  if (p.artists?.length) parts.push(`${p.genres?.length || p.keywords?.length ? 'of ' : ''}${p.artists.join(', ')}`);
  if (p.venues?.length) parts.push(`bij ${p.venues.join(' of ')}`);
  if (p.cities?.length) parts.push(`in ${p.cities.map(cityLabel).join(' of ')}`);
  if (p.from && p.to) parts.push(`${dateLabel(p.from)} t/m ${dateLabel(p.to)}`);
  else if (p.from) parts.push(`vanaf ${dateLabel(p.from)}`);
  else if (p.to) parts.push(`t/m ${dateLabel(p.to)}`);
  if (p.priceMaxEuro != null) parts.push(`tot €${p.priceMaxEuro}`);
  return parts.join(' · ');
}

/** " fred again usb " — dezelfde woordgrenzen als `words()` in match.ts. */
const words = (t: string) => ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/**
 * Waarom een event bij een melding past, in een paar woorden. Komt in de
 * push en in "Gevonden voor jou": "Met Pixies", "new wave · "80s" in de
 * aankondiging", "folk, via Abigail Lapell". Dezelfde volgorde als
 * `ALERT_MATCH`: eerst de artiest, dan genre en trefwoord samen.
 */
export function whyMatched(
  alert: { genres: string[] | null; artistNames: string[] | null; keywords: string[] | null; label: string },
  event: {
    title: string;
    category: string;
    genres: string[];
    description: string | null;
    lineup: string[];
    headliner: { name: string; genres: string[] } | null;
  }
): string {
  const title = words(event.title);
  const lineup = event.lineup.map((n) => n.toLowerCase());
  const artist = (alert.artistNames ?? []).find(
    (a) => lineup.includes(a.toLowerCase()) || (a.length >= 4 && title.includes(words(a)))
  );
  if (artist) return `Met ${artist}`;

  const parts: string[] = [];
  const wanted = (alert.genres ?? []) as GenreKey[];
  if (wanted.length) {
    const cat = event.category as Category;
    const own = mainGenresOf(cat, event.genres).filter((k) => wanted.includes(k));
    if (own.length) parts.push(own.map((k) => GENRES[k].label).join(', '));
    else if (event.headliner) {
      const via = genresOf(cat, event.headliner.genres.slice(0, 2)).filter((k) => wanted.includes(k));
      if (via.length) parts.push(`${via.map((k) => GENRES[k].label).join(', ')}, via ${event.headliner.name}`);
    }
  }
  const text = words(`${event.title} ${event.description ?? ''}`);
  const kw = (alert.keywords ?? []).find((k) => text.includes(words(k)));
  if (kw) parts.push(`"${kw}" in de aankondiging`);
  if (parts.length) return parts.join(' · ');
  return `Past bij je melding: ${alert.label.length > 70 ? `${alert.label.slice(0, 67)}…` : alert.label}`;
}
