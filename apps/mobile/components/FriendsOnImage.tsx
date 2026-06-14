/**
 * Avatar-stack overlay voor op een event-image, Instagram-stijl
 * "liked by X & Y" — laat vrienden zien die deze occurrence hebben
 * gesaved. Positioneert zichzelf absolute linksonder; caller plaatst
 * het binnen de banner-View.
 */
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import type { ApiFriendBadge } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { fontFamily, palette } from '@/theme/tokens';

export function FriendsOnImage({
  friends,
  totalCount,
}: {
  friends: ApiFriendBadge[];
  /** Server kan meer friends hebben dan in `friends` (top-3); deze
      override is voor de "+ N" suffix. Default: friends.length. */
  totalCount?: number;
}) {
  const t = useT();
  const locale = useLocale();
  if (friends.length === 0) return null;
  const total = totalCount ?? friends.length;
  const visible = friends.slice(0, 3);
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.stack}>
        {visible.map((f, i) => (
          <View
            key={`${f.id}-${i}`}
            style={[styles.avatar, { marginLeft: i === 0 ? 0 : -8 }]}
          >
            {f.avatarUrl ? (
              <Image
                source={{ uri: f.avatarUrl }}
                style={styles.avatarImg}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.avatarImg, styles.avatarFallback]}>
                <Text style={styles.avatarInitial}>
                  {(f.name.trim()[0] ?? '?').toUpperCase()}
                </Text>
              </View>
            )}
          </View>
        ))}
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {labelFor(friends, total, t, locale)}
      </Text>
    </View>
  );
}

function labelFor(
  friends: ApiFriendBadge[],
  total: number,
  t: ReturnType<typeof useT>,
  _locale: ReturnType<typeof useLocale>
): string {
  const first = friends[0]?.name.split(' ')[0] ?? '';
  if (total === 1) return first;
  if (total === 2) {
    const second = friends[1]?.name.split(' ')[0] ?? '';
    return `${first} ${t('& ', '& ')}${second}`;
  }
  const others = total - 1;
  return `${first} ${t(`+ ${others}`, `+ ${others}`)}`;
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    // Halftransparante donkere pill zodat de avatars + label zichtbaar
    // zijn op elke image-kleur, zonder de foto te overstemmen.
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  stack: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: '#fff',
    overflow: 'hidden',
  },
  avatarImg: { width: '100%', height: '100%' },
  avatarFallback: {
    backgroundColor: palette.noir2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontFamily: fontFamily.bold,
    fontSize: 10,
    color: '#fff',
  },
  label: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: -0.1,
    color: '#fff',
    maxWidth: 220,
  },
});
