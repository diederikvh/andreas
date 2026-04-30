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

import { Cross } from '@/components/Cross';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

type Props = {
  onSubmit: (profile: { name: string; phone: string }) => void;
};

export function Welkom({ onSubmit }: Props) {
  const roles = useRoles();
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
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.logo}>
        <Cross size={17} thickness={4.2} color={roles.accent} />
        <Text style={[styles.logoWord, { color: roles.fg }]}>Andreas</Text>
      </View>

      <Text style={[styles.kicker, { color: roles.accent }]}>— Welkom</Text>

      <Text style={[styles.title, { color: roles.fg }]}>
        Hoe heet{'\n'}je{' '}
        <Text style={[styles.titleEm, { color: roles.accent2 }]}>eigenlijk</Text>?
      </Text>

      <Text style={[styles.sub, { color: roles.fgMuted }]}>
        We bouwen je netwerk handmatig. Geen contacten-import, geen suggesties.
        Jij voegt zelf toe.
      </Text>

      <View style={styles.fields}>
        <View style={styles.field}>
          <Text style={[styles.label, { color: roles.fgMuted }]}>Naam</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Roos van Dijk"
            placeholderTextColor={roles.fgMuted}
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
          <Text style={[styles.label, { color: roles.fgMuted }]}>Telefoon</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="+31 6 …"
            placeholderTextColor={roles.fgMuted}
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
              <Text style={[styles.goLabel, { color: roles.onAccent }]}>Verder</Text>
              <Text style={[styles.goArrow, { color: roles.onAccent }]}>→</Text>
            </View>
          )}
        </Pressable>
        <Text style={[styles.tiny, { color: roles.fgMuted }]}>
          Door verder te gaan ga je akkoord met de afspraken.{'\n'}
          Lezen kan, hoeft niet vandaag.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 24, paddingTop: 56, paddingBottom: 28 },
  logo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logoWord: {
    fontFamily: fontFamily.display,
    fontSize: 16,
    letterSpacing: -0.16,
    textTransform: 'uppercase',
  },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    marginTop: 36,
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
