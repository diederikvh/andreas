import type { PendingShareKind } from './pendingShare';

/**
 * Lokaal bepalen of gedeelde content waarschijnlijk een **ticket** is, en
 * niet een poster of een aankondiging.
 *
 * Waarom dit moet kloppen: het bepaalt welke intentie Andreas voorstelt.
 * Een ticket betekent ✓ Ik ga (je hebt al betaald), een poster betekent
 * ♡ Wil ik heen. Zit dit ernaast, dan zet Andreas iets in je agenda wat je
 * nooit hebt gezegd — dus liever twijfelen dan gokken, en de gebruiker kan
 * het altijd omzetten.
 *
 * Puur en zonder React-Native-imports, dus testbaar op echte ticket- en
 * postertekst.
 *
 * **Een ontbrekende barcode is geen bewijs dat het geen ticket is.** Op iOS
 * vindt `scanFromURLAsync` alleen QR (zie `importBarcode.ts`), dus een
 * ticket met een streepjescode komt hier zonder code binnen. De
 * tekstsignalen moeten de drempel daarom op eigen kracht kunnen halen.
 */

export type TicketSignal =
  | 'barcode'
  | 'ticketWords'
  | 'ticketNumber'
  | 'orderNumber'
  | 'seat'
  | 'pdf';

export type TicketVerdict = {
  isTicket: boolean;
  /** 0..1 */
  score: number;
  signals: TicketSignal[];
};

/** Welke intentie stellen we voor? Altijd een voorstel, nooit een besluit. */
export type Intent = 'going' | 'save';

/**
 * Woorden die alleen op een toegangsbewijs staan. Bewust **niet** het losse
 * woord "tickets": dat staat net zo goed op een poster ("Tickets vanaf
 * vrijdag 10:00"), en dat is verkoopinformatie — fase 10, niet een ticket.
 */
const TICKET_WORDS =
  /\b(e-?ticket|admit\s+one|admission|toegangsbewijs|toegangskaart|entreebewijs|entreekaart|ticketbewijs|scan\s+(?:deze|this)\s+(?:code|qr))\b/i;

/** "Ticket 4417993-02", "kaartnr: 88123". Minstens 4 cijfers, anders
    matcht "ticket 2" uit een poster-zin. */
const TICKET_NUMBER =
  /\b(?:ticket|kaart)\s*(?:nr|no|nummer|number|id)?\.?\s*[:#]?\s*[a-z0-9-]*\d{4,}/i;

/** "Ordernummer 3391827", "bestelnr 88123", "booking reference AB12CD34". */
const ORDER_NUMBER =
  /\b(?:order|bestel|boeking|booking|reference|referentie)\s*(?:nr|no|nummer|number|id|code)?\.?\s*[:#]?\s*[a-z0-9-]*\d{4,}/i;

/** "Rij 4", "Stoel 12", "Vak C", "Row H Seat 22". */
const SEAT =
  /\b(?:rij|row|stoel|seat|vak|sector|blok|block|balkon|tribune|staanplaats)\s*[:#]?\s*[a-z]?\d{1,4}\b/i;

const WEIGHTS: Record<TicketSignal, number> = {
  // Een QR of streepjescode is het sterkste enkele signaal: posters hebben
  // er soms een, maar dan naast veel minder ticket-achtige tekst.
  barcode: 0.45,
  ticketWords: 0.3,
  ticketNumber: 0.3,
  orderNumber: 0.25,
  seat: 0.25,
  // Een PDF is zelden een poster en vaak een ticket. Klein duwtje, nooit
  // beslissend op zichzelf.
  pdf: 0.15,
};

const THRESHOLD = 0.5;

/**
 * OCR levert regels, niet zinnen. "E-TICKET" kwam op de testposter terug
 * als "E-" en "TICKET" op twee regels — zonder deze stap vuurt het
 * `ticketWords`-signaal daar niet, en juist op een kaal ticket dat geen
 * nummers prijsgeeft is dat het enige signaal dat je hebt.
 *
 * Dus: een afbreekstreepje aan het eind van een regel plakken we vast, en
 * alle andere witruimte wordt één spatie.
 */
function flatten(text: string): string {
  return text.replace(/-\s*\n\s*/g, '-').replace(/\s+/g, ' ');
}

export function detectTicket(input: {
  /** Alle OCR-tekst, of de gedeelde tekst bij een tekst-share. */
  text: string;
  /** Types uit `detectBarcodeTypes()`; de inhoud kennen we bewust niet. */
  barcodeTypes: string[];
  kind: PendingShareKind;
}): TicketVerdict {
  const { barcodeTypes, kind } = input;
  const text = flatten(input.text);
  const signals: TicketSignal[] = [];

  if (barcodeTypes.length > 0) signals.push('barcode');
  if (TICKET_WORDS.test(text)) signals.push('ticketWords');
  if (TICKET_NUMBER.test(text)) signals.push('ticketNumber');
  if (ORDER_NUMBER.test(text)) signals.push('orderNumber');
  if (SEAT.test(text)) signals.push('seat');
  if (kind === 'pdf') signals.push('pdf');

  const score = Math.min(
    1,
    signals.reduce((sum, s) => sum + WEIGHTS[s], 0)
  );

  return { isTicket: score >= THRESHOLD, score, signals };
}

/**
 * Ticket → ✓ Ik ga, al het andere → ♡ Wil ik heen.
 *
 * Een link of losse tekst is per definitie een ontdekking en geen bewijs
 * van een kaartje, ook niet als er "ticket" in de URL staat.
 */
export function suggestedIntent(
  verdict: TicketVerdict,
  kind: PendingShareKind
): Intent {
  if (kind === 'url' || kind === 'text') return 'save';
  return verdict.isTicket ? 'going' : 'save';
}
