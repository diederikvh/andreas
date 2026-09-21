/**
 * Waar een melding je heen wilde brengen, tot de app er klaar voor is.
 *
 * Tik je op een melding terwijl de app níet loopt, dan komt die tik
 * binnen terwijl de startflow nog aan het draaien is. Die flow doet na
 * de splash een `router.replace('/avond')` en gooit daarmee alles weg
 * wat de melding al had geopend -- vandaar dat elke ochtendmelding op
 * de homepage uitkwam.
 *
 * Dus niet racen: de melding legt z'n bestemming hier neer, en de
 * startflow pakt 'm op zodra hij zelf klaar is. Loopt de app al, dan is
 * er niets om op te wachten en navigeert de melding direct.
 *
 * Module-scope en geen store: dit leeft één tik lang en niemand hoeft
 * erop te renderen.
 */
let pending: string | null = null;
let bootDone = false;

/** De startflow is klaar met z'n eigen navigatie. */
export function markBootDone(): void {
  bootDone = true;
}

/** Mag een melding nu zelf navigeren, of moet de startflow het doen? */
export function isBootDone(): boolean {
  return bootDone;
}

export function setPendingDeepLink(url: string): void {
  pending = url;
}

/** Eenmalig ophalen. Twee keer lezen levert de tweede keer niets op,
    zodat een bestemming niet per ongeluk dubbel geopend wordt. */
export function takePendingDeepLink(): string | null {
  const url = pending;
  pending = null;
  return url;
}
