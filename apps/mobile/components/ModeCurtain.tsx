import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { create } from 'zustand';

import { brandEase } from '@/lib/easing';
import { useModeStore } from '@/store/mode';
import { motion, roles, type Mode } from '@/theme/tokens';

/**
 * Internal trigger registry. The mounted curtain registers a function
 * that consumers can call from anywhere via `useModeSwitch()`.
 */
type Trigger = (to: Mode) => void;

type CurtainStore = {
  trigger: Trigger | null;
  setTrigger: (t: Trigger | null) => void;
};

const useCurtainStore = create<CurtainStore>((set) => ({
  trigger: null,
  setTrigger: (t) => set({ trigger: t }),
}));

// Mirrors the curtain-sweep keyframes in app.html:
//   0%   translateX(100%)   ← off-screen right
//   45%  translateX(0)      ← fully covering
//   55%  translateX(0)      ← hold (Andreas-kruis on display)
//   100% translateX(-100%)  ← off-screen left
const SWEEP_IN = Math.round(motion.curtain * 0.45); // 405ms
const HOLD = Math.round(motion.curtain * 0.10); //  90ms
const SWEEP_OUT = motion.curtain - SWEEP_IN - HOLD; // 405ms

/**
 * Full-bleed overlay that performs the mode-swap "gordijn" transition.
 * Sweeps in from the right, holds across a brief 90ms beat with the
 * Andreas-kruis centred, then sweeps out to the left. The mode flips
 * during the hold so the user only sees the new mode once the curtain
 * has cleared.
 *
 * Mount once at the root.
 */
export function ModeCurtain() {
  // 1 = off-screen right (hidden), 0 = covering, -1 = off-screen left (hidden).
  const offset = useSharedValue(1);
  const spin = useSharedValue(0);
  const [bg, setBg] = useState<string>(roles.nacht.curtainBg);
  const [fg, setFg] = useState<string>(roles.nacht.curtainFg);
  const setMode = useModeStore((s) => s.setMode);
  const setTrigger = useCurtainStore((s) => s.setTrigger);

  useEffect(() => {
    const trigger: Trigger = (to) => {
      // Curtain colour = the destination mode's canvas/accent. Pulled from
      // `roles[from].curtainBg/curtainFg`, which is already defined as
      // "the OTHER mode" relative to the current canvas.
      const from: Mode = to === 'nacht' ? 'dag' : 'nacht';
      setBg(roles[from].curtainBg);
      setFg(roles[from].curtainFg);
      offset.value = 1;
      offset.value = withSequence(
        withTiming(
          0,
          { duration: SWEEP_IN, easing: brandEase },
          (finished) => {
            'worklet';
            if (finished) runOnJS(setMode)(to);
          }
        ),
        withDelay(
          HOLD,
          withTiming(-1, { duration: SWEEP_OUT, easing: brandEase })
        )
      );
      spin.value = 0;
      spin.value = withTiming(360, {
        duration: motion.curtain,
        easing: brandEase,
      });
    };
    setTrigger(trigger);
    return () => setTrigger(null);
  }, [offset, spin, setMode, setTrigger]);

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
    height: 12,
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
  return () => {
    const { mode, setMode } = useModeStore.getState();
    const to: Mode = mode === 'nacht' ? 'dag' : 'nacht';
    if (trigger) {
      trigger(to);
    } else {
      setMode(to);
    }
  };
}
