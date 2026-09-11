import { scanFromURLAsync, type BarcodeType } from 'expo-camera';

/**
 * Barcode-detectie op een lokaal bestand, voor de vraag "is dit een ticket?".
 *
 * We geven **alleen de types** terug, nooit de inhoud. De waarde in een
 * ticket-QR is precies wat het toestel niet mag verlaten, en wat we niet
 * vasthouden kan ook niet per ongeluk in een payload of een crashreport
 * belanden. Andreas hoeft alleen te weten *dat* er een code op staat; bij
 * "toon ticket" (fase 8) laten we het originele bestand zien, dus de
 * gedecodeerde waarde hebben we nergens voor nodig.
 *
 * Gebruikt `scanFromURLAsync` uit expo-camera — die zat er al voor de
 * vriend-QR-scanner, dus dit kost geen nieuwe dependency.
 *
 * **Let op, de twee platforms kunnen niet hetzelfde.** iOS gebruikt intern
 * `CIDetector(ofType: CIDetectorTypeQRCode)` en negeert de meegegeven
 * types: daar vinden we dus **alleen QR**. Android laat ML Kit de hele
 * lijst doen. Een ticket met alleen een streepjescode of een Aztec-code
 * wordt op iOS dus niet als ticket herkend via deze route — de
 * tekstsignalen uit fase 6 (ticketnummer, "toegang", stoel/rij) moeten het
 * werk daar alleen doen. Bouw de ticket-heuristiek er niet op alsof een
 * ontbrekende code betekent "dit is geen ticket".
 */

/** Wat ticketproviders in de praktijk printen. Geen `upc_*`: dat zijn
    winkelproducten, en een streepjescode op een bierblikje in je
    poster-foto moet geen ticket-signaal worden. */
const TICKET_BARCODE_TYPES: BarcodeType[] = [
  'qr',
  'aztec',
  'pdf417',
  'datamatrix',
  'code128',
  'code39',
  'code93',
  'ean13',
  'itf14',
  'codabar',
];

export async function detectBarcodeTypes(uri: string): Promise<string[]> {
  try {
    const hits = await scanFromURLAsync(uri, TICKET_BARCODE_TYPES);
    return [...new Set(hits.map((h) => h.type))];
  } catch {
    // Geen leesbare afbeelding, of niks gevonden. Beide betekenen
    // "geen code" — een import mag hier niet op stuklopen.
    return [];
  }
}
