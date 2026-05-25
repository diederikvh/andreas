import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { ModePick } from '@/components/start/ModePick';
import { Splash } from '@/components/start/Splash';
import { useSession } from '@/lib/authClient';
import { useModeStore, useRoles } from '@/store/mode';

const SPLASH_HOLD_MS = 1600;

type Stage = 'splash' | 'mode';

/**
 * Start flow op cold-start:
 *  - Ingelogd → /avond (returning user, happy path).
 *  - Niet ingelogd + al eens onboarded → /jij?onboarding=1
 *    (mode-keuze is al persisted, dus skip de mode-pick; alleen
 *    phone-OTP opnieuw).
 *  - Niet ingelogd + nooit onboarded → splash → mode-pick →
 *    /jij?onboarding=1 (eerste-keer-volledige flow).
 *
 * Zodra de gebruiker een handle heeft (= profile compleet), markeert
 * /jij `hasOnboarded` en replace't naar /avond.
 */
export default function StartScreen() {
  const roles = useRoles();
  const [stage, setStage] = useState<Stage>('splash');
  const { data: session, isPending: sessionPending } = useSession();

  useEffect(() => {
    if (stage !== 'splash') return;
    // Wacht tot we weten of er een sessie is — anders kan een snelle
    // redirect een ingelogde user toch naar onboarding sturen.
    if (sessionPending) return;
    const isAuthed = Boolean(session?.user?.id);
    const t = setTimeout(() => {
      const { hasOnboarded } = useModeStore.getState();
      if (isAuthed) {
        router.replace('/avond');
      } else if (hasOnboarded) {
        router.replace('/jij?onboarding=1');
      } else {
        setStage('mode');
      }
    }, SPLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [stage, sessionPending, session]);

  const handlePicked = () => {
    // hasOnboarded zetten we NIET hier — pas zodra /jij de phone-OTP-
    // flow heeft afgerond. Zo komt iemand die de app sluit tijdens
    // de phone-step bij volgende start netjes terug bij mode-pick.
    router.replace('/jij?onboarding=1');
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
