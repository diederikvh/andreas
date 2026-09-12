import TextRecognition from '@react-native-ml-kit/text-recognition';
import { File } from 'expo-file-system';
import { Image } from 'react-native';

/**
 * On-device OCR via ML Kit. Tekst van een gedeelde poster of screenshot
 * komt hier binnen als blokken met een bounding box, zodat fase 3 kan
 * zien wát het grootst op de poster staat — dat is vrijwel altijd de
 * eventtitel.
 *
 * Blijft volledig lokaal: ML Kit heeft z'n model in de app en doet geen
 * netwerkcall. De output gaat nooit rechtstreeks naar de server, alleen
 * via de whitelist in [importPayload.ts](./importPayload.ts).
 *
 * ML Kit geeft geen confidence per blok (de RN-wrapper exposeert het niet),
 * dus fase 3 moet het met tekst + geometrie doen.
 */

export type OcrBox = { x: number; y: number; width: number; height: number };

export type OcrLine = {
  text: string;
  box: OcrBox | null;
};

export type OcrBlock = {
  text: string;
  /** Bounding box in pixels van het bronbeeld. Soms leeg gelaten door ML Kit. */
  box: OcrBox | null;
  /**
   * De losse regels binnen dit blok, mét eigen box.
   *
   * Hier moet fase 3 op werken, niet op `box.height`. ML Kit groepeert
   * regels die bij elkaar horen tot één blok, dus de blok-hoogte is de
   * hoogte van de hele groep. Op de testposter kwam de datumregel
   * ("zaterdag 18 oktober 2026 / deuren 19:30 / aanvang 20:30") daardoor
   * op 153px uit terwijl de titel in veel groter font op 114px stond:
   * twee regels bij elkaar zijn hoger dan één grote. Regelhoogte is wél
   * een bruikbare proxy voor fontgrootte.
   */
  lines: OcrLine[];
};

/** Hoogte van de grootste regel in een blok — de proxy voor fontgrootte
    waarmee "grootste tekst = titel" te benaderen is. 0 als ML Kit geen
    geometrie meegaf. */
export function maxLineHeight(block: OcrBlock): number {
  return block.lines.reduce((max, l) => Math.max(max, l.box?.height ?? 0), 0);
}

export type OcrResult = {
  /** Alle tekst achter elkaar, in leesorde. */
  fullText: string;
  blocks: OcrBlock[];
};

export const EMPTY_OCR: OcrResult = { fullText: '', blocks: [] };

function toBox(frame?: {
  left: number;
  top: number;
  width: number;
  height: number;
}): OcrBox | null {
  if (!frame) return null;
  return {
    x: frame.left,
    y: frame.top,
    width: frame.width,
    height: frame.height,
  };
}

/**
 * Waarom dit bestand niet te lezen is, of `null` als het wél kan.
 *
 * **Dit moet vóór elke ML Kit-aanroep.** De iOS-module doet
 * `[UIImage imageWithData:]` en geeft het resultaat ongecontroleerd door
 * aan `MLKVisionImage initWithImage:`. Is dat nil, dan vliegt er een
 * ObjC-exception op de turbomodule-queue en gaat de app hard onderuit —
 * SIGABRT, geen afgewezen promise, dus geen try/catch in JS die daar nog
 * bij komt. Zo crashte de import op 12 sep 2026. Android faalt op z'n
 * eigen manier met een null-bitmap.
 *
 * Je loopt hier tegenaan met een bestand dat er niet meer is (een share
 * uit een vorige sessie waarvan `pruneImportDir` het bestand al opruimde),
 * met een lege kopie van een provider die niets gaf, en met iets dat wel
 * een afbeelding heet maar het niet is. De reden staat in de melding
 * zodat het debugpaneel laat zien wat er aan de hand was.
 */
async function unreadableReason(uri: string): Promise<string | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return 'bestand bestaat niet meer';
    if (file.size === 0) return 'bestand is leeg';
  } catch {
    return 'geen geldig pad';
  }
  // Bestaat en heeft bytes — maar is het ook een beeld dat dit toestel
  // uitpakt? Dezelfde decoders als waar ML Kit op leunt, maar dan met een
  // callback in plaats van een crash.
  const decodes = await new Promise<boolean>((resolve) => {
    Image.getSize(
      uri,
      (w, h) => resolve(w > 0 && h > 0),
      () => resolve(false),
    );
  });
  return decodes ? null : 'geen leesbaar beeldformaat';
}

/**
 * @param uri `file://`-URI van een lokale afbeelding. ML Kit leest via
 * `NSURL`, dus een plat pad zonder scheme werkt niet.
 */
export async function recognizeImageText(uri: string): Promise<OcrResult> {
  const reason = await unreadableReason(uri);
  if (reason) throw new Error(`${reason} (${uri})`);
  const result = await TextRecognition.recognize(uri);
  return {
    fullText: result.text,
    blocks: result.blocks.map((b) => ({
      text: b.text,
      box: toBox(b.frame),
      lines: b.lines.map((l) => ({ text: l.text, box: toBox(l.frame) })),
    })),
  };
}
