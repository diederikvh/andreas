import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { create } from 'zustand';

import { brandEase } from '@/lib/easing';
import { useModeStore } from '@/store/mode';
import { motion, roles, type Mode } from '@/theme/tokens';

/**
 * Internal trigger registry. The mounted curtain registers a function
 * that consumers can call from anywhere via `useModeSwitch()`.
 *
 * Optional `onCommit` callback runs op het moment dat de curtain volledig
 * dekkend is (gelijktijdig met de mode-flip). Gebruik dit om andere
 * state-flips (bv. content-mode) ook onder de curtain te verstoppen.
 */
type Trigger = (to: Mode, onCommit?: () => void) => void;

type CurtainStore = {
  trigger: Trigger | null;
  setTrigger: (t: Trigger | null) => void;
};

const useCurtainStore = create<CurtainStore>((set) => ({
  trigger: null,
  setTrigger: (t) => set({ trigger: t }),
}));

// Curtain heeft drie fasen:
//   sweep-in   → curtain schuift van rechts in beeld (covering)
//   commit     → setMode + 2× requestAnimationFrame zodat React de
//                nieuwe kleuren daadwerkelijk heeft gecommit voordat
//                de curtain wegtrekt. Vervangt de oude vaste HOLD van
//                90ms — die was vaak korter dan de re-render op zware
//                schermen (event/venue), waardoor de gebruiker de
//                oude mode nog zag terwijl de curtain al wegtrok.
//   sweep-out  → curtain schuift naar links uit beeld (revealing)
const SWEEP_IN = Math.round(motion.curtain * 0.45); // 405ms
const SWEEP_OUT = Math.round(motion.curtain * 0.45); // 405ms

/**
 * Full-bleed overlay dat de mode-swap "gordijn"-transitie uitvoert.
 * Sweept rechts in beeld, gates op een commit-frame zodat React de
 * nieuwe mode-kleuren heeft gerendered, en sweept dan links uit beeld.
 * Synchronisatie is hard: sweep-out start pas na de render-commit.
 *
 * Mount één keer in de root.
 */
export function ModeCurtain() {
  // 1 = off-screen right (hidden), 0 = covering, -1 = off-screen left (hidden).
  const offset = useSharedValue(1);
  const spin = useSharedValue(0);
  const [bg, setBg] = useState<string>(roles.nacht.curtainBg);
  const [fg, setFg] = useState<string>(roles.nacht.curtainFg);
  const setMode = useModeStore((s) => s.setMode);
  const setTrigger = useCurtainStore((s) => s.setTrigger);

  // onCommit-callback wordt gezet door trigger() en uitgevoerd in
  // commitAndSweepOut, gelijktijdig met setMode. Ref ipv via runOnJS
  // doorgeven zodat functie-referenties niet over de thread-grens
  // hoeven (Reanimated handelt dat niet schoon af).
  const onCommitRef = useRef<(() => void) | null>(null);

  // Flippt de mode en wacht twee frames (zodat React commit) voordat
  // de curtain z'n sweep-out start. Twee RAFs: de eerste wordt vóór de
  // commit gequeued (in dezelfde batch als setMode), de tweede vuurt
  // pas ná de commit op de volgende frame. Eventuele extra state-flips
  // (content-mode etc.) lopen mee in dezelfde batch.
  const commitAndSweepOut = useCallback(
    (to: Mode) => {
      setMode(to);
      const cb = onCommitRef.current;
      onCommitRef.current = null;
      cb?.();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          offset.value = withTiming(-1, {
            duration: SWEEP_OUT,
            easing: brandEase,
          });
        });
      });
    },
    [offset, setMode]
  );

  useEffect(() => {
    const trigger: Trigger = (to, onCommit) => {
      onCommitRef.current = onCommit ?? null;
      // Curtain colour = the destination mode's canvas/accent. Pulled from
      // `roles[from].curtainBg/curtainFg`, which is already defined as
      // "the OTHER mode" relative to the current canvas.
      const from: Mode = to === 'nacht' ? 'dag' : 'nacht';
      setBg(roles[from].curtainBg);
      setFg(roles[from].curtainFg);
      offset.value = 1;
      offset.value = withTiming(
        0,
        { duration: SWEEP_IN, easing: brandEase },
        (finished) => {
          'worklet';
          if (finished) runOnJS(commitAndSweepOut)(to);
        }
      );
      spin.value = 0;
      spin.value = withTiming(360, {
        duration: motion.curtain,
        easing: brandEase,
      });
    };
    setTrigger(trigger);
    return () => setTrigger(null);
  }, [offset, spin, commitAndSweepOut, setTrigger]);

  const animated = useAnimatedStyle(() => ({
    transform: [{ translateX: `${offset.value * 100}%` }],
  }));

  const crossAnimated = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.curtain, { backgroundColor: bg }, animated]}
    >
      <Animated.View style={[styles.cross, crossAnimated]}>
        <View
          style={[
            styles.crossBar,
            { backgroundColor: fg, transform: [{ rotate: '45deg' }] },
          ]}
        />
        <View
          style={[
            styles.crossBar,
            { backgroundColor: fg, transform: [{ rotate: '-45deg' }] },
          ]}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  curtain: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cross: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crossBar: {
    position: 'absolute',
    width: 72,
    height: 18,
    borderRadius: 1,
  },
});

/**
 * Toggle the mode through the curtain transition. Falls back to a plain
 * setMode if the curtain isn't mounted (shouldn't happen in app, but
 * keeps the hook safe for tests / storybook).
 */
export function useModeSwitch() {
  const trigger = useCurtainStore((s) => s.trigger);
  return (onCommit?: () => void) => {
    const { mode, setMode } = useModeStore.getState();
    const to: Mode = mode === 'nacht' ? 'dag' : 'nacht';
    if (trigger) {
      trigger(to, onCommit);
    } else {
      setMode(to);
      onCommit?.();
    }
  };
}
