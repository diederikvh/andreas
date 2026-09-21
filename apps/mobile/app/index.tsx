import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { ModePick } from '@/components/start/ModePick';
import { Splash } from '@/components/start/Splash';
import { ensureAnonymousSession, useSession } from '@/lib/authClient';
import { markBootDone, takePendingDeepLink } from '@/lib/pendingDeepLink';
import { useModeStore, useRoles } from '@/store/mode';

const SPLASH_HOLD_MS = 1600;

/**
 * Naar de homepage, en als een melding je ergens anders heen wilde
 * brengen dan daar bovenop.
 *
 * De homepage blijft dus onder de bestemming liggen: terugswipen brengt
 * je waar je anders ook geweest zou zijn, niet terug naar deze splash.
 */
function goHome(): void {
  router.replace('/avond');
  const target = takePendingDeepLink();
  markBootDone();
  if (!target) return;
  try {
    router.push(target as any);
  } catch (err) {
    console.warn('[push] navigate failed', target, err);
  }
}

type Stage = 'splash' | 'mode';

/**
 * Start flow op cold-start:
 *  - Al eens onboarded → /avond. Punt.
 *  - Eerste keer → splash → mode-pick → /avond.
 *
 * Er wordt niet meer om een account gevraagd. Bij eerste start loggen we
 * stil anoniem in; dat levert een user-rij en sessie op zodat je meteen
 * kunt saven, wegtikken en volgen, en zodat de dagelijkse push ergens
 * aan kan hangen. Een echt account is pas nodig zodra er andere mensen
 * bij komen kijken (vrienden, uitnodigen, delen) — dat vraagt de app
 * dáár, niet vooraf.
 *
 * `hasOnboarded` betekent nu dus "mode gekozen", niet "profiel af".
 */
export default function StartScreen() {
  const roles = useRoles();
  const [stage, setStage] = useState<Stage>('splash');
  const { data: session, isPending: sessionPending } = useSession();

  // Zorg tijdens de splash dat er een identiteit is. Loopt parallel aan
  // de splash-hold, dus in de praktijk kost 't geen wachttijd.
  useEffect(() => {
    if (sessionPending) return;
    if (!session?.user?.id) void ensureAnonymousSession();
  }, [sessionPending, session]);

  useEffect(() => {
    if (stage !== 'splash') return;
    if (sessionPending) return;
    const t = setTimeout(() => {
      const { hasOnboarded } = useModeStore.getState();
      if (hasOnboarded) goHome();
      else setStage('mode');
    }, SPLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [stage, sessionPending]);

  const handlePicked = () => {
    // Mode gekozen = onboarding klaar. Er komt geen inlogstap meer
    // achteraan, dus dit is het moment om 't af te vinken.
    useModeStore.getState().completeOnboarding();
    goHome();
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {stage === 'splash' && (
        <Animated.View
          key="splash"
          style={StyleSheet.absoluteFill}
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(350)}
        >
          <Splash />
        </Animated.View>
      )}

      {stage === 'mode' && (
        <Animated.View
          key="mode"
          style={StyleSheet.absoluteFill}
          entering={FadeIn.duration(350)}
          exiting={FadeOut.duration(250)}
        >
          <ModePick onPicked={handlePicked} />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
