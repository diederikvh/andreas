/**
 * Geen beweringen over wie je volgt die niet kloppen. Het model haalt
 * "voor fans van Slowdive" uit een beschrijving en maakt er "die je volgt"
 * van, ook met een instructie ertegen. Noemt de reden geen artiest die je
 * echt volgt, dan gaat dat zinsdeel eruit; de rest blijft staan.
 */
export function honestReason(reason: string, followed: string[]): string {
  if (!/je volgt/i.test(reason)) return reason;
  const lower = reason.toLowerCase();
  if (followed.some((n) => n.length >= 3 && lower.includes(n))) return reason;
  return reason
    .replace(/,?\s*(die|dat|wie)\s+je\s+volgt/gi, '')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}
