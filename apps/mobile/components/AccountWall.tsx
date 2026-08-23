/**
 * Wat je ziet op een sociaal scherm zonder account.
 *
 * Sinds anoniem-eerst kom je hier binnen mét een sessie maar zónder
 * persoon. Dat gaf lege schermen met een doodlopende tekst ("log in via
 * Jij") en geen knop — je moest zelf bedenken waar dat dan was. Deze
 * muur zegt wat je mist en brengt je er in één tik heen.
 *
 * Bewust geen dwang: je kunt het scherm gewoon sluiten en anoniem
 * verder. De rest van de app blijft werken.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { softTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

export function AccountWall({
  icon = 'people-outline',
  title,
  body,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  /** Wat een account je hier oplevert — geen uitleg van wat er ontbreekt. */
  body: string;
}) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={styles.wrap}>
      <Ionicons name={icon} size={48} color={roles.fgMuted} />
      <Text style={[styles.title, { color: roles.fg }]}>{title}</Text>
      <Text style={[styles.body, { color: roles.fgMuted }]}>{body}</Text>
      <Pressable
        onPress={() => {
          softTap();
          router.push('/jij' as never);
        }}
        style={[styles.cta, { backgroundColor: roles.accent }]}
      >
        <Text style={[styles.ctaText, { color: roles.onAccent }]}>
          {t('Maak een account', 'Create an account')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
    gap: 12,
  },
  title: {
    fontFamily: fontFamily.displayBold,
    fontSize: 22,
    letterSpacing: -0.44,
    textAlign: 'center',
    marginTop: 4,
  },
  body: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  cta: {
    marginTop: 10,
    height: 48,
    paddingHorizontal: 26,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: {
    fontFamily: fontFamily.displayBold,
    fontSize: 15,
    letterSpacing: -0.2,
  },
});
