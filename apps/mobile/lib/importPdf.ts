import { File } from 'expo-file-system';
import PdfThumbnail from 'react-native-pdf-thumbnail';

/**
 * PDF → afbeelding, lokaal, zodat de OCR- en barcode-route uit fase 2 er
 * ook op kan. PDFKit (iOS) en `PdfRenderer` (Android) doen het werk; er
 * gaat niets over de lijn.
 *
 * **Resolutie is de beperking.** `react-native-pdf-thumbnail` rendert op
 * de mediaBox-maat van de pagina, dus een A4 wordt ~595×842 px. Grote
 * tekst leest daar prima uit, maar de kleine regels op een ticket
 * (ticketnummer, stoel/rij) zitten dan rond de 8-10px en dat is voor OCR
 * aan de ondergrens. Er is geen scale-parameter, alleen JPEG-kwaliteit —
 * die zetten we op 100 zodat we er geen compressie-artefacten bovenop
 * krijgen. Als de herkenning op echte ticket-PDF's tekortkomt is de
 * volgende stap een eigen Expo-module die op 2× rendert; dat is de enige
 * knop die er nog aan zit.
 */

export type PdfRender = { uri: string; width: number; height: number };

/** @param page 0-indexed. */
export async function renderPdfPage(
  uri: string,
  page = 0
): Promise<PdfRender | null> {
  try {
    const { uri: out, width, height } = await PdfThumbnail.generate(
      uri,
      page,
      100
    );
    return { uri: out, width, height };
  } catch {
    return null;
  }
}

/**
 * Alle pagina's van een PDF, voor het volledig-scherm bekijken. Een
 * ticket van twee kantjes of een flyer met een achterkant moet je kunnen
 * doorscrollen.
 *
 * Duurder dan één pagina, dus alleen aanroepen als de gebruiker ook
 * écht kijkt — niet tijdens de herkenning, die heeft aan pagina 1 genoeg.
 */
export async function renderPdfPages(uri: string): Promise<PdfRender[]> {
  try {
    const pages = await PdfThumbnail.generateAllPages(uri, 100);
    return pages.map((p) => ({ uri: p.uri, width: p.width, height: p.height }));
  } catch {
    return [];
  }
}

/**
 * Gooi de gerenderde pagina weg zodra de herkenning klaar is. De render
 * landt in de cache-dir — het systeem ruimt die uiteindelijk zelf op,
 * maar een uitgeklede ticketpagina wil je niet langer laten staan dan
 * nodig.
 */
export function discardPdfRender(uri: string): string | null {
  try {
    const f = new File(uri);
    if (!f.exists) return `bestaat niet: ${uri}`;
    f.delete();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
