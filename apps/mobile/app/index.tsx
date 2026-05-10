import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { ModePick } from '@/components/start/ModePick';
import { Splash } from '@/components/start/Splash';
import { useModeStore, useRoles } from '@/store/mode';

const SPLASH_HOLD_MS = 1600;

type Stage = 'splash' | 'mode';

/**
 * Start flow: splash → mode-keuze → phone-OTP onboarding → home.
 * Na de mode-pick gaat de gebruiker direct naar /jij?onboarding=1
 * waar de bestaande phone+code+profile-flow het account aanmaakt.
 * Zodra de gebruiker een handle heeft (= profile compleet), markeert
 * /jij `hasOnboarded` en replace't naar /avond.
 *
 * Returning users met `hasOnboarded === true` slaan alles over en
 * landen direct op /avond — ook als 'r geen sessie meer is (logout).
 * Ze kunnen via de avatar-stip terug naar /jij om in te loggen.
 */
export default function StartScreen() {
  const roles = useRoles();
  const [stage, setStage] = useState<Stage>('splash');

  useEffect(() => {
    if (stage !== 'splash') return;
    const t = setTimeout(() => {
      const { hasOnboarded } = useModeStore.getState();
      if (hasOnboarded) {
        router.replace('/avond');
      } else {
        setStage('mode');
      }
    }, SPLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [stage]);

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
