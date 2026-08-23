/**
 * Een rij die je naar links of rechts wegveegt, zoals je je inbox
 * opruimt. Rechts = interessant, links = niks voor mij.
 *
 * Twee dingen bepalen of dit prettig werkt:
 *
 * 1. **Het gebaar mag niet vechten met de lijst.** Zonder `activeOffsetX`
 *    claimt de pan bij de eerste pixel en scroll je niet meer verticaal;
 *    met alleen `activeOffsetX` blijft een schuine veeg alsnog twijfelen.
 *    Vandaar ook `failOffsetY`: gaat je vinger eerst omhoog of omlaag,
 *    dan geeft de rij het gebaar meteen terug aan de SectionList.
 *
 * 2. **Er moet iets zichtbaar worden tijdens het slepen.** Anders veeg je
 *    blind en weet je pas na afloop wat er gebeurde. De achtergrond
 *    kleurt mee en het icoon verschijnt zodra je over de drempel bent.
 *
 * 3. **De tik hoort hier, niet in de rij zelf.** Liet je halverwege een
 *    veeg los, dan veerde de rij netjes terug maar opende de
 *    Pressable van EventListRow alsnog het detail: die twee weten
 *    niets van elkaar. Vandaar dat de tap hier als gesture zit en via
 *    `Gesture.Exclusive` verliest van de pan — heeft de pan geclaimd,
 *    dan komt de tap niet meer aan bod.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { softTap } from '@/lib/haptics';
import { useRoles } from '@/store/mode';

/** Hoe ver je moet slepen voordat loslaten telt als een oordeel. */
const THRESHOLD_RATIO = 0.3;
/** Of een snelle flick het al doet, ook zonder die afstand. */
const FLING_VELOCITY = 900;

export function SwipeableRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  onPress,
  enabled = true,
}: {
  children: ReactNode;
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  /** Gewone tik op de rij. Hoort hier en niet op het kind — zie punt 3. */
  onPress?: () => void;
  enabled?: boolean;
}) {
  const roles = useRoles();
  const { width } = useWindowDimensions();
  const threshold = width * THRESHOLD_RATIO;
  const x = useSharedValue(0);
  const height = useSharedValue<number | undefined>(undefined);

  const commit = (dir: 'left' | 'right') => {
    softTap();
    if (dir === 'right') onSwipeRight();
    else onSwipeLeft();
  };

  const pan = Gesture.Pan()
    .enabled(enabled)
    // Pas claimen na 12px horizontaal, en meteen opgeven bij 10px
    // verticaal — zo blijft scrollen door de lijst het standaardgebaar.
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      x.value = e.translationX;
    })
    .onEnd((e) => {
      const far = Math.abs(e.translationX) > threshold;
      const fast = Math.abs(e.velocityX) > FLING_VELOCITY;
      if (!far && !fast) {
        x.value = withSpring(0, { damping: 20, stiffness: 200 });
        return;
      }
      const dir = e.translationX > 0 ? 'right' : 'left';
      // Uit beeld vliegen en pas dán committen: de rij verdwijnt uit de
      // lijst zodra 't oordeel binnen is, dus andersom zie je 'm
      // halverwege de animatie wegknippen.
      x.value = withTiming(
        dir === 'right' ? width : -width,
        { duration: 180 },
        () => runOnJS(commit)(dir)
      );
    });

  const tap = Gesture.Tap()
    .enabled(Boolean(onPress))
    .maxDuration(400)
    .onEnd((_e, success) => {
      if (success && onPress) runOnJS(onPress)();
    });

  // Volgorde telt: pan eerst, dus die wint zodra 'ie geactiveerd is.
  const gesture = Gesture.Exclusive(pan, tap);

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
  }));

  // Achtergrond kleurt op naarmate je vordert; op de drempel is 'ie vol.
  const bgStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      Math.abs(x.value),
      [0, threshold],
      [0, 1],
      'clamp'
    ),
  }));
  const yesStyle = useAnimatedStyle(() => ({ opacity: x.value > 0 ? 1 : 0 }));
  const noStyle = useAnimatedStyle(() => ({ opacity: x.value < 0 ? 1 : 0 }));

  return (
    <View
      onLayout={(e) => {
        height.value = e.nativeEvent.layout.height;
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.behind, bgStyle]}
      >
        <Animated.View style={[styles.side, yesStyle]}>
          <Ionicons name="heart" size={22} color={roles.accent} />
        </Animated.View>
        <Animated.View style={[styles.side, styles.sideRight, noStyle]}>
          <Ionicons name="close" size={22} color={roles.fgMuted} />
        </Animated.View>
      </Animated.View>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{ backgroundColor: roles.bg }, rowStyle]}>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  behind: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
  },
  side: { justifyContent: 'center' },
  sideRight: { marginLeft: 'auto' },
});
