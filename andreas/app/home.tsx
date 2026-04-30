import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useModeStore, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Placeholder destination after onboarding. Will be replaced by the
 * 5-tab layout (Avond / Agenda / Kaart / Gered / Jij) in fase 2.
 */
export default function Home() {
  const roles = useRoles();
  const toggle = useModeStore((s) => s.toggle);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <Text style={[styles.kicker, { color: roles.accent }]}>— Tabs komen hier</Text>
      <Text style={[styles.title, { color: roles.fg }]}>Andreas</Text>
      <Text style={[styles.body, { color: roles.fgMuted }]}>
        Placeholder. Fase 2 bouwt de 5-tab navigatie en de feed.
      </Text>
      <Pressable
        onPress={toggle}
        style={({ pressed }) => [
          styles.toggle,
          { backgroundColor: roles.accent, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Text style={[styles.toggleLabel, { color: roles.onAccent }]}>
          Wissel mode
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    letterSpacing: -1.3,
    textTransform: 'uppercase',
  },
  body: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 280,
  },
  toggle: {
    marginTop: 16,
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
  toggleLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    letterSpacing: 0.14,
    textTransform: 'uppercase',
  },
});
