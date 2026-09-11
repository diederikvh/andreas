import TextRecognition from '@react-native-ml-kit/text-recognition';

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
 * @param uri `file://`-URI van een lokale afbeelding. ML Kit leest via
 * `NSURL`, dus een plat pad zonder scheme werkt niet.
 */
export async function recognizeImageText(uri: string): Promise<OcrResult> {
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
