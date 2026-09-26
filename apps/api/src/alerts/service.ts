/**
 * Wat de MCP-tools en de app-routes voor meldingen delen: de leesbare
 * samenvatting van een regel. Eén plek, zodat Claude en het scherm in de
 * app precies hetzelfde zeggen.
 */
import { GENRES, type GenreKey } from './genres.js';

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
