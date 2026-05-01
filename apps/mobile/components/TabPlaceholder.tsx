import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

type Props = {
  /** Tab name shown as the display title (uppercased). */
  name: string;
  /** Optional extra content below the placeholder copy (e.g. DEV-knoppen). */
  children?: ReactNode;
};

/**
 * Shared placeholder for the five tabs until fase 2 fills them in.
 */
export function TabPlaceholder({ name, children }: Props) {
  const roles = useRoles();
  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <Text style={[styles.title, { color: roles.fg }]}>{name}</Text>
      <Text style={[styles.body, { color: roles.fgMuted }]}>
        Placeholder · komt in fase 2
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    letterSpacing: -1.3,
    textTransform: 'uppercase',
  },
  body: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
