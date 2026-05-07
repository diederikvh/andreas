import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

type Props = {
  onSubmit: (profile: { name: string; phone: string }) => void;
};

export function Welkom({ onSubmit }: Props) {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [focused, setFocused] = useState<'name' | 'phone' | null>(null);

  const canSubmit = name.trim().length > 0 && phone.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSubmit({ name: name.trim(), phone: phone.trim() });
  };

  const inputBorderColor = (which: 'name' | 'phone') =>
    focused === which ? roles.accent : roles.bgChip;

  return (
    // Outer View owns the safe-area padding so it stays put.
    // KAV only handles keyboard offset (its animated paddingBottom would
    // otherwise overwrite ours when the keyboard is hidden).
    <View
      style={[
        styles.root,
        {
          // Math.max guards devices without a notch / home-indicator —
          // we always want at least a visible breathing strip.
          paddingTop: Math.max(insets.top + 24, 56),
          paddingBottom: Math.max(insets.bottom + 28, 44),
        },
      ]}
    >
    <KeyboardAvoidingView
      style={styles.kavInner}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={[styles.kicker, { color: roles.accent }]}>
        {t('— Welkom', '— Welcome')}
      </Text>

      <Text style={[styles.title, { color: roles.fg }]}>
        {t('Eerst dit.', 'First this.')}
      </Text>

      <Text style={[styles.sub, { color: roles.fgRead }]}>
        {t(
          'Zo kunnen vrienden je later vinden in Andreas X.',
          'So friends can find you later in Andreas X.'
        )}
      </Text>

      <View style={styles.fields}>
        <View style={styles.field}>
          <Text style={[styles.label, { color: roles.fgMuted }]}>
            {t('Naam', 'Name')}
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Roos van Dijk"
            placeholderTextColor={roles.fgPlaceholder}
            autoComplete="name"
            textContentType="name"
            onFocus={() => setFocused('name')}
            onBlur={() => setFocused(null)}
            selectionColor={roles.accent}
            style={[
              styles.input,
              { color: roles.fg, borderBottomColor: inputBorderColor('name') },
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: roles.fgMuted }]}>
            {t('Telefoon', 'Phone')}
          </Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="+31 6 …"
            placeholderTextColor={roles.fgPlaceholder}
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            onFocus={() => setFocused('phone')}
            onBlur={() => setFocused(null)}
            selectionColor={roles.accent}
            style={[
              styles.input,
              { color: roles.fg, borderBottomColor: inputBorderColor('phone') },
            ]}
          />
        </View>
      </View>

      <View style={styles.cta}>
        <Pressable onPress={handleSubmit} disabled={!canSubmit}>
          {({ pressed }) => (
            <View
              style={[
                styles.go,
                {
                  backgroundColor: roles.accent,
                  opacity: !canSubmit ? 0.45 : pressed ? 0.92 : 1,
                  transform: [{ scale: pressed ? 0.98 : 1 }],
                },
              ]}
            >
              <Text style={[styles.goLabel, { color: roles.onAccent }]}>
                {t('Verder', 'Continue')}
              </Text>
              <Text style={[styles.goArrow, { color: roles.onAccent }]}>→</Text>
            </View>
          )}
        </Pressable>
        <Text style={[styles.tiny, { color: roles.fgMuted }]}>
          {t(
            'Door verder te gaan ga je akkoord met de voorwaarden.',
            'By continuing you agree to the terms.'
          )}
        </Text>
      </View>
    </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24 },
  kavInner: { flex: 1 },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 36,
    lineHeight: 36 * 0.95,
    letterSpacing: -1.26,
    marginTop: 10,
  },
  titleEm: {
    fontFamily: fontFamily.body,
    fontWeight: '400',
  },
  sub: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  fields: { marginTop: 32, gap: 14 },
  field: { gap: 6 },
  label: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  input: {
    paddingVertical: 10,
    fontFamily: fontFamily.bold,
    fontSize: 22,
    letterSpacing: -0.33,
    borderBottomWidth: 1.5,
  },
  cta: { marginTop: 'auto', gap: 12 },
  go: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 22,
    borderRadius: 999,
  },
  goLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 15,
    letterSpacing: 0.15,
  },
  goArrow: {
    fontFamily: fontFamily.displayBold,
    fontSize: 18,
  },
  tiny: {
    textAlign: 'center',
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    lineHeight: 16,
  },
});
