import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useModeSwitch } from '@/components/ModeCurtain';
import { TabPlaceholder } from '@/components/TabPlaceholder';
import { useModeStore, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export default function Jij() {
  const roles = useRoles();
  const switchMode = useModeSwitch();

  const resetOnboarding = async () => {
    await useModeStore.persist.clearStorage();
    useModeStore.setState({ mode: 'nacht', hasOnboarded: false });
    router.replace('/');
  };

  return (
    <TabPlaceholder name="Jij">
      <View style={styles.actions}>
        <Pressable onPress={() => router.push('/welkom')}>
          {({ pressed }) => (
            <View
              style={[
                styles.button,
                { backgroundColor: roles.accent, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.buttonLabel, { color: roles.onAccent }]}>
                Stel je even voor
              </Text>
            </View>
          )}
        </Pressable>
        <Pressable
          onPress={switchMode}
          style={({ pressed }) => [
            styles.devButton,
            { borderColor: roles.fgMuted, opacity: pressed ? 0.5 : 1 },
          ]}
        >
          <Text style={[styles.devLabel, { color: roles.fgMuted }]}>
            DEV · wissel mode
          </Text>
        </Pressable>
        <Pressable
          onPress={resetOnboarding}
          style={({ pressed }) => [
            styles.devButton,
            { borderColor: roles.fgMuted, opacity: pressed ? 0.5 : 1 },
          ]}
        >
          <Text style={[styles.devLabel, { color: roles.fgMuted }]}>
            DEV · reset onboarding
          </Text>
        </Pressable>
      </View>
    </TabPlaceholder>
  );
}

const styles = StyleSheet.create({
  actions: { marginTop: 16, alignItems: 'center', gap: 8 },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
  buttonLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 14,
    letterSpacing: 0.14,
    textTransform: 'uppercase',
  },
  devButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
  },
  devLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
  },
});
