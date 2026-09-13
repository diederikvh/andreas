/**
 * Pure parsers voor De Brakke Grond: speeldata uit de ticketkolom, en
 * de velden van agenda- en detailpagina's uit de HTML. Apart van
 * brakkegrond.ts zodat het te testen is zonder DB-verbinding.
 *
 * De pagina's zijn server-rendered; tot 13 sep 2026 werd dit met
 * Playwright uit de DOM gelezen, wat niet nodig bleek.
 */
import { parseAmsterdamLocal } from './_amsterdam-tz.js';

const DUTCH_MONTHS_SHORT: Record<string, number> = {
  jan: 1, feb: 2, mrt: 3, mar: 3, maart: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};

export type Slot = { startsAt: Date; endsAt: Date | null };

/** Zelfde drempel als refineKindByDuration: langer dan dit is het geen
    reeks voorstellingen meer maar een doorlopende periode. */
const SPAN_DAYS = 7;


/** "wo 21 okt '26" → de kale datum. Jaar staat er altijd bij, dus geen
    gok meer op basis van een anchor — dat ging sowieso mis voor alles
    verder dan een jaar vooruit, en hier staat programmering tot juli '27. */
function parseDayToken(token: string): { y: number; m: number; d: number } | null {
  const m = token.match(/(\d{1,2})\s+([a-z]{3,})\.?\s*'(\d{2})/i);
  if (!m) return null;
  const month = DUTCH_MONTHS_SHORT[m[2]!.slice(0, 3).toLowerCase()];
  if (!month) return null;
  return { y: 2000 + parseInt(m[3]!, 10), m: month, d: parseInt(m[1]!, 10) };
}

function atAmsterdam(p: { y: number; m: number; d: number }, hh: number, mi: number): Date {
  const pad = (n: number) => String(n).padStart(2, '0');
  return parseAmsterdamLocal(`${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(hh)}:${pad(mi)}:00`);
}

/**
 * De ticketkolom is de enige plek waar de speeldata betrouwbaar staan:
 *
 *   .event-detail__tickets-date   "wo 21 okt '26—do 22 okt '26"   reeks
 *                                 "vr 18 sep '26"                 los
 *                                 "vr 18 sep '26,zo 25 okt '26"   lijst
 *   .event-detail__tickets-info   "Grote zaal 20:00 uur"
 *
 * De tijd staat dus in een ánder element dan de datum; daarom vond een
 * regex over de datumtekst nooit iets.
 *
 * Per speeldag een occurrence, maar alleen als er een tijd staat én de
 * reeks kort is. Zonder tijd is het een expositie, residentie of
 * meerdaags festival — dat is één doorlopende periode, geen serie
 * voorstellingen. Mu.ZEE loopt van 14 apr tot 18 jul '27: als losse
 * dagen zijn dat 96 rijen die de agenda dichtslibben.
 */
export function parseTicketSlots(dateText: string, infoText: string): Slot[] {
  const t = infoText.match(/(\d{1,2})[:.](\d{2})/);
  const hh = t ? parseInt(t[1]!, 10) : 0;
  const mi = t ? parseInt(t[2]!, 10) : 0;
  const slots: Slot[] = [];

  for (const group of dateText.split(',')) {
    const parts = group.split(/[\u2014\u2013]/).map((x) => x.trim()).filter(Boolean);
    const from = parseDayToken(parts[0] ?? '');
    if (!from) continue;
    const to = parts.length > 1 ? parseDayToken(parts[1]!) : null;

    if (!to) {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: null });
      continue;
    }

    // Dagstappen via UTC: die kent geen DST, dus een reeks die over de
    // klokwissel heen loopt verschuift niet. De Amsterdam-offset komt er
    // per dag weer op in atAmsterdam.
    const firstUtc = Date.UTC(from.y, from.m - 1, from.d);
    const lastUtc = Date.UTC(to.y, to.m - 1, to.d);
    if (lastUtc < firstUtc) {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: null });
      continue;
    }
    const days = Math.round((lastUtc - firstUtc) / 86_400_000) + 1;

    if (t && days <= SPAN_DAYS) {
      for (const c = new Date(firstUtc); c.getTime() <= lastUtc; c.setUTCDate(c.getUTCDate() + 1)) {
        const day = { y: c.getUTCFullYear(), m: c.getUTCMonth() + 1, d: c.getUTCDate() };
        slots.push({ startsAt: atAmsterdam(day, hh, mi), endsAt: null });
      }
    } else {
      slots.push({ startsAt: atAmsterdam(from, hh, mi), endsAt: atAmsterdam(to, 23, 59) });
    }
  }
  return slots;
}


// ── HTML-parsers ─────────────────────────────────────────────────────

function tekst(fragment: string | undefined): string {
  if (!fragment) return '';
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inhoud van het eerste element met class `naam`. */
function byClass(html: string, naam: string): string | undefined {
  const re = new RegExp(
    `<(div|span|h[1-6]|p|a|li)[^>]*\\bclass="[^"]*\\b${naam}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`,
    'i'
  );
  return html.match(re)?.[2];
}

export type AgendaCard = { url: string; category: string };

/**
 * Show-URLs van /agenda, met het type van de kaart. Dat label zit in
 * `.card-default__category` (of `.event-highlights__categories` op de
 * uitgelichte kaart) en staat op de detailpagina nergens — daarom moet
 * het hier mee.
 */
export function parseAgendaCards(html: string, origin = 'https://brakkegrond.nl'): AgendaCard[] {
  const out: AgendaCard[] = [];
  const gezien = new Set<string>();
  // Per kaart-blok, zodat een categorie niet bij de buren vandaan komt.
  for (const blok of html.split(/(?=<(?:li|div)[^>]*class="[^"]*(?:card-default__wrap|event-highlights__container))/).slice(1)) {
    const href = blok.match(/href="([^"]*\/agenda\/\d+\/[a-z][a-z0-9-]*)"/i)?.[1];
    if (!href) continue;
    const url = href.startsWith('http') ? href : origin + href;
    if (gezien.has(url)) continue;
    gezien.add(url);
    out.push({
      url,
      category: tekst(byClass(blok, 'card-default__category') ?? byClass(blok, 'event-highlights__categories')),
    });
  }
  return out;
}

export type ShowPage = {
  title: string;
  description: string | null;
  imageUrl: string | null;
  dateText: string;
  infoText: string;
  infoParts: string[];
};

/** Velden van een detailpagina. */
export function parseShowPage(html: string): ShowPage | null {
  const title = tekst(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  if (!title) return null;

  // Hi-res staat op de fullscreen-trigger; de <img> is een thumbnail.
  const image =
    html.match(/class="[^"]*fullscreen--trigger[^"]*"[^>]*\bdata-src="([^"]+)"/i)?.[1] ??
    html.match(/<img[^>]*\bclass="[^"]*gallery-block__item-image[^"]*"[^>]*\bsrc="([^"]+)"/i)?.[1] ??
    html.match(/<img[^>]*\bclass="[^"]*gallery-block__item-image[^"]*"[^>]*\bdata-src="([^"]+)"/i)?.[1] ??
    null;

  // Meerdere text-blocks kunnen voorkomen; pak de eerste met echte tekst
  // in plaats van alleen credits of witruimte.
  let description = '';
  const blokRe = /<div[^>]*\bclass="[^"]*\b(?:text-block|event-detail__english-description)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(blokRe)) {
    const t = tekst(m[1]);
    if (t.length > 80) { description = t; break; }
  }

  const infoHtml = html.match(
    /<div[^>]*\bclass="[^"]*\bevent-detail__tickets-info\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<a|<\/div>)/i
  )?.[1] ?? '';
  const infoParts = [...infoHtml.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((m) => tekst(m[1]))
    .filter(Boolean);

  return {
    title,
    description: description.length > 30 ? description : null,
    imageUrl: image && !image.startsWith('data:') ? image : null,
    // <br>—<br> tussen de datums: naar tekst met de streep ertussen.
    dateText: tekst(byClass(html, 'event-detail__tickets-date')),
    infoText: tekst(infoHtml),
    infoParts,
  };
}
