/**
 * Wat de MCP-tools en de app-routes voor meldingen delen: de leesbare
 * samenvatting van een regel, en de proef waarmee een smaakregel bij het
 * aanmaken laat zien hoe de keurder hem opvat. Eén plek, zodat Claude en
 * het scherm in de app precies hetzelfde zeggen.
 */
import { GENRES, type GenreKey } from './genres.js';
import { judgeMany, loadEventInfo } from './judge.js';
import { recentCandidates, type AlertFilters } from './match.js';

const dayFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long' });
const dateLabel = (d: string) => dayFmt.format(new Date(`${d}T12:00:00Z`));
export const cityLabel = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

/** "smaak: "…" · muziek · in Amsterdam" — het label dat op de regel komt. */
export function describeAlert(p: {
  taste?: string;
  genres?: GenreKey[];
  artists?: string[];
  venues?: string[];
  cities?: string[];
  categories?: string[];
  from?: string;
  to?: string;
  priceMaxEuro?: number;
}): string {
  const parts: string[] = [];
  if (p.taste) parts.push(`smaak: "${p.taste}"`);
  if (p.genres?.length) parts.push(p.genres.map((g) => GENRES[g].label).join(' of '));
  if (p.categories?.length) parts.push(p.categories.map((c) => c.toLowerCase()).join(' of '));
  if (p.artists?.length) parts.push(p.artists.join(' of '));
  if (p.venues?.length) parts.push(`bij ${p.venues.join(' of ')}`);
  if (p.cities?.length) parts.push(`in ${p.cities.map(cityLabel).join(' of ')}`);
  if (p.from && p.to) parts.push(`${dateLabel(p.from)} t/m ${dateLabel(p.to)}`);
  else if (p.from) parts.push(`vanaf ${dateLabel(p.from)}`);
  else if (p.to) parts.push(`t/m ${dateLabel(p.to)}`);
  if (p.priceMaxEuro != null) parts.push(`tot €${p.priceMaxEuro}`);
  return parts.join(' · ');
}

export type TasteSampleItem = { id: string; title: string; venue: string; reason: string };

/** Hoeveel recente kandidaten de proef van een smaakregel laat keuren. */
const TASTE_SAMPLE = 25;

/**
 * Keur de laatst toegevoegde events binnen de grenzen tegen de smaak. Over
 * wat er al staat komt geen melding; dit laat alleen zien hoe de keurder
 * de omschrijving opvat, met de redenen erbij.
 */
export async function previewTaste(
  filters: AlertFilters,
  taste: string
): Promise<{ sampled: number; yes: TasteSampleItem[]; no: TasteSampleItem[] }> {
  const ids = await recentCandidates(filters, TASTE_SAMPLE);
  const info = await loadEventInfo(ids);
  const verdicts = await judgeMany(taste, [...info.values()]);
  const item = (id: string): TasteSampleItem => ({
    id,
    title: info.get(id)!.title,
    venue: info.get(id)!.venue,
    reason: verdicts.get(id)!.reason,
  });
  return {
    sampled: ids.length,
    yes: ids.filter((id) => verdicts.get(id)?.match).map(item),
    no: ids.filter((id) => verdicts.get(id) && !verdicts.get(id)!.match).map(item),
  };
}
