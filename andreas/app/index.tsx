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
 * Start flow: splash → mode-keuze → home. The Welkom (naam + telefoon)
 * step is no longer part of this flow — it's deferred to the first
 * action that needs an account (save, add-friend) and lives at
 * /welkom as a modal route.
 */
export default function StartScreen() {
  const roles = useRoles();
  const completeOnboarding = useModeStore((s) => s.completeOnboarding);
  const [stage, setStage] = useState<Stage>('splash');

  useEffect(() => {
    if (stage !== 'splash') return;
    const t = setTimeout(() => {
      const { hasOnboarded } = useModeStore.getState();
      if (hasOnboarded) {
        router.replace('/home');
      } else {
        setStage('mode');
      }
    }, SPLASH_HOLD_MS);
    return () => clearTimeout(t);
  }, [stage]);

  const handlePicked = () => {
    completeOnboarding();
    router.replace('/home');
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
