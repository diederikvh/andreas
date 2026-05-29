/**
 * In-app toast voor binnenkomende pushes. Wanneer de app open is en
 * er komt een notificatie binnen (friend-request, invite, RSVP), gleed
 * 'r een banner van bovenaf het scherm in met titel + body. Tap =
 * navigeer naar `data.url` van de push. Auto-dismiss na ~5s; swipe-up
 * om eerder te sluiten.
 *
 * Architectuur:
 *  - Context-based portal (`InboxToastProvider`) zodat de banner boven
 *    álle schermen + sheets + modals zit, zoals ZoomLayer voor pinch.
 *  - PushManager roept `showToast()` aan bij elke ontvangen push.
 *  - Wachtrij van max 3; één tegelijk zichtbaar. Volgende slaat
 *    direct in na dismiss van de huidige.
 */
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

type ToastInput = {
  title: string;
  body: string;
  /** URL om naar te navigeren bij tap. Mag null/undefined zijn — dan is
      de tap een no-op (maar de banner sluit wel). */
  url?: string | null;
};

type Ctx = { showToast: (t: ToastInput) => void };

const ToastCtx = createContext<Ctx | null>(null);

export function useInboxToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    throw new Error('useInboxToast must be used inside <InboxToastProvider>');
  }
  return ctx;
}

const SLIDE_DISTANCE = 220;

export function InboxToastProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ToastInput | null>(null);
  const queue = useRef<ToastInput[]>([]);

  const showToast = useCallback((t: ToastInput) => {
    // Cap op 3 wachtende — bij een storm aan pushes overspoelen we de
    // gebruiker niet.
    if (queue.current.length >= 3) return;
    queue.current.push(t);
    setActive((curr) => curr ?? queue.current.shift() ?? null);
  }, []);

  const next = useCallback(() => {
    setActive(queue.current.shift() ?? null);
  }, []);

  useEffect(() => {
    if (!active) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [active]);

  return (
    <ToastCtx.Provider value={{ showToast }}>
      {children}
      <ToastSurface toast={active} onDismiss={next} />
    </ToastCtx.Provider>
  );
}

function ToastSurface({
  toast,
  onDismiss,
}: {
  toast: ToastInput | null;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const translateY = useSharedValue(-SLIDE_DISTANCE);
  const opacity = useSharedValue(0);

  useEffect(() => {
    if (toast) {
      // Strakke timing-curve i.p.v. spring — minder bouncy, voelt
      // rustiger bij een actie-vereist-notificatie.
      translateY.value = withTiming(0, {
        duration: 260,
        easing: Easing.out(Easing.cubic),
      });
      opacity.value = withTiming(1, { duration: 200 });
    } else {
      translateY.value = withTiming(-SLIDE_DISTANCE, {
        duration: 200,
        easing: Easing.in(Easing.cubic),
      });
      opacity.value = withTiming(0, { duration: 160 });
    }
  }, [toast, translateY, opacity]);

  const onTap = useCallback(() => {
    if (!toast) return;
    const url = toast.url;
    onDismiss();
    if (url) {
      // Kleine vertraging zodat de slide-out niet wordt geinterrupted
      // door de router-mount van het detail-scherm.
      setTimeout(() => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          router.push(url as any);
        } catch {
          // url kan ongeldig zijn — stilletjes negeren.
        }
      }, 80);
    }
  }, [toast, onDismiss]);

  // Swipe-up om weg te halen. Gesture-handler in plaats van Pressable
  // omdat we visueel feedback geven (translateY volgt de vinger).
  const pan = Gesture.Pan()
    .activeOffsetY([-10, 30])
    .onUpdate((e) => {
      if (e.translationY < 0) {
        translateY.value = Math.max(-SLIDE_DISTANCE, e.translationY);
      }
    })
    .onEnd((e) => {
      if (e.translationY < -40 || e.velocityY < -500) {
        translateY.value = withTiming(-SLIDE_DISTANCE, {
          duration: 180,
          easing: Easing.in(Easing.cubic),
        });
        runOnJS(onDismiss)();
      } else {
        translateY.value = withTiming(0, {
          duration: 220,
          easing: Easing.out(Easing.cubic),
        });
      }
    });

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!toast) return null;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.wrap,
            {
              top: insets.top + 8,
              backgroundColor: roles.accent,
            },
            animStyle,
          ]}
        >
          <View style={styles.inner}>
            <Pressable onPress={onTap} style={styles.tapArea}>
              <Ionicons
                name="notifications"
                size={20}
                color={roles.onAccent}
              />
              <View style={styles.text}>
                <Text
                  numberOfLines={1}
                  style={[styles.title, { color: roles.onAccent }]}
                >
                  {toast.title}
                </Text>
                <Text
                  numberOfLines={2}
                  style={[styles.body, { color: roles.onAccent, opacity: 0.85 }]}
                >
                  {toast.body}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={onDismiss}
              hitSlop={10}
              style={styles.closeBtn}
            >
              <Ionicons
                name="close"
                size={18}
                color={roles.onAccent}
              />
            </Pressable>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 14,
    right: 14,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 14,
    elevation: 8,
    overflow: 'hidden',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 6,
    gap: 4,
  },
  // Pressable die titel + body + icoon dekt: tap = navigate. Close-knop
  // staat ernaast en mag NIET dezelfde tap-area triggeren — vandaar
  // gesplitst.
  tapArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: { flex: 1, gap: 2 },
  title: {
    fontFamily: fontFamily.displayBold,
    fontSize: 15,
    lineHeight: 18,
    letterSpacing: -0.2,
  },
  body: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: -0.1,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
