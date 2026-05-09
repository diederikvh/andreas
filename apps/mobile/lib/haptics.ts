import * as Haptics from 'expo-haptics';

/**
 * Subtiele tap-feedback voor frequent geraakte controls (tab-bar,
 * filter-chips, filter-knop, saved-search-chips). Gebruikt
 * `ImpactFeedbackStyle.Light` zodat je 't merkt zonder dat 't
 * overweldigend wordt na 50 taps in een sessie.
 *
 * Async call zwaait fire-and-forget; we vangen errors stilletjes
 * (sommige iOS/Android-states geven een rejected promise terug,
 * geen reden om de UI te onderbreken).
 */
export function tinyTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {
    // intentioneel leeg
  });
}

/**
 * Iets steviger feedback — voor "main action"-taps zoals een filter
 * sheet openen of een saved-search activeren. Niet voor lijsten
 * waar elke tap één van vele is.
 */
export function softTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {
    // intentioneel leeg
  });
}
