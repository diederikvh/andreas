/**
 * "Meer" — alles wat eerder als knoppenrij op de homepage stond.
 *
 * De homepage was een stapel ingangen bovenop de rails: vier grote
 * banners plus zeven kleine icoonknopjes, allemaal boven de eigenlijke
 * programmering. Die ingangen zijn hier naartoe verhuisd zodat Vandaag
 * weer over vanavond gaat en niet over navigatie.
 *
 * Drie groepen, in volgorde van hoe vaak je ze nodig hebt:
 *   1. Doen — Vraag Andreas, wat is er nieuw, wat raden we aan.
 *   2. Vrienden.
 *   3. Bladeren per soort — live, theater, clubs, film, kaart, venues.
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { useSession } from '@/lib/authClient';
import { softTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useMe, useNewArrivalsSince, useSocialBadgeCount } from '@/lib/queries';
import { useNewFilters } from '@/store/newFilters';
import { useRoles } from '@/store/mode';
import { useNewBadgeSince } from '@/store/sessionTimestamps';
import { useZoekStore } from '@/store/zoek';
import { fontFamily } from '@/theme/tokens';

type Entry = {
  key: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  badge?: number;
  onPress: () => void;
};

export default function MeerScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const openGuide = useZoekStore((s) => s.openGuide);

  // Dezelfde teller als op Vandaag: hoeveel staat er klaar om te
  // beoordelen, ná jouw baan-voorkeur.
  const { data: session } = useSession();
  const since = useNewBadgeSince();
  const activeLanes = useNewFilters((s) => s.activeLanes);
  const { data: arrivals } = useNewArrivalsSince(since, {
    enabled: Boolean(session?.user?.id),
    lanes: activeLanes,
  });
  const newCount = arrivals?.total ?? 0;

  // `users.guideEnabled` is een opt-in per gebruiker uit het
  // admin-paneel — /zoek geeft 403 zonder die vlag, dus de ingang mag
  // niet zichtbaar zijn als 'ie uitstaat. Stond eerder op de banner die
  // ik weghaalde; hier hoort 'ie weer.
  const { data: me } = useMe();
  const guideEnabled = me?.guideEnabled ?? false;
  const socialCount = useSocialBadgeCount(Boolean(session?.user?.id));

  const go = (path: string) => () => {
    softTap();
    router.push(path as never);
  };

  const doen: Entry[] = [
    ...(guideEnabled
      ? [
          {
            key: 'gids',
            icon: <Cross20 color={roles.accent} />,
            label: t('Vraag Andreas', 'Ask Andreas'),
            hint: t('Zeg waar je zin in hebt', 'Say what you feel like'),
            onPress: () => {
              softTap();
              openGuide();
            },
          },
        ]
      : []),
    {
      key: 'new',
      icon: <Ionicons name="flash-outline" size={22} color={roles.accent} />,
      label: t('Nieuwe aanwinsten', 'New additions'),
      hint: t('Beoordeel wat er bij kwam', 'Rate what came in'),
      badge: newCount,
      onPress: go('/new'),
    },
    {
      key: 'voor-jou',
      icon: <Ionicons name="heart-outline" size={22} color={roles.accent} />,
      label: t('Aanbevolen', 'Recommended'),
      hint: t('Op basis van je smaak', 'Based on your taste'),
      onPress: go('/voor-jou'),
    },
  ];

  const vrienden: Entry[] = [
    {
      key: 'social',
      icon: <Ionicons name="people-outline" size={22} color={roles.accent} />,
      label: t('Vrienden', 'Friends'),
      hint: t('Wat zij bewaarden', 'What they saved'),
      badge: socialCount,
      onPress: go('/social'),
    },
    {
      key: 'going',
      icon: <Ionicons name="footsteps-outline" size={22} color={roles.accent} />,
      label: t('Wie gaat waarheen', "Who's going where"),
      onPress: go('/going'),
    },
  ];

  // Volgorde is Diederiks prioriteit, niet alfabetisch of per
  // datavolume: live en theater eerst, film verderop. Films zijn de
  // grootste categorie in aantal, maar dat is precies waarom ze niet
  // bovenaan hoeven.
  const bladeren: Entry[] = [
    {
      key: 'live',
      icon: (
        <Ionicons name="musical-notes-outline" size={22} color={roles.accent} />
      ),
      label: t('Live muziek', 'Live music'),
      onPress: go('/live'),
    },
    {
      key: 'theater',
      icon: (
        <MaterialCommunityIcons name="drama-masks" size={22} color={roles.accent} />
      ),
      label: t('Theater', 'Theatre'),
      onPress: go('/theater'),
    },
    {
      key: 'clubs',
      icon: <Ionicons name="disc-outline" size={22} color={roles.accent} />,
      label: t('Clubs', 'Clubs'),
      onPress: go('/clubs'),
    },
    {
      key: 'films',
      icon: <Ionicons name="film-outline" size={22} color={roles.accent} />,
      label: t('Films', 'Films'),
      onPress: go('/films'),
    },
    {
      key: 'kaart',
      icon: <Ionicons name="map-outline" size={22} color={roles.accent} />,
      label: t('Kaart', 'Map'),
      onPress: go('/kaart'),
    },
    {
      key: 'venues',
      icon: <Ionicons name="business-outline" size={22} color={roles.accent} />,
      label: t('Venues', 'Venues'),
      onPress: go('/venues'),
    },
  ];

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 96,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Group entries={doen} />
        <Group entries={vrienden} />
        <Group entries={bladeren} label={t('Bladeren', 'Browse')} />
      </ScrollView>
      <AppHeader title={t('Meer', 'More')} />
    </View>
  );
}

function Group({ entries, label }: { entries: Entry[]; label?: string }) {
  const roles = useRoles();
  return (
    <View style={styles.groupWrap}>
      {label && (
        <Text style={[styles.groupLabel, { color: roles.fgMuted }]}>
          {label}
        </Text>
      )}
      <View style={[styles.group, { backgroundColor: roles.bgLift }]}>
        {entries.map((e, i) => (
          <Row key={e.key} entry={e} last={i === entries.length - 1} />
        ))}
      </View>
    </View>
  );
}

function Row({ entry, last }: { entry: Entry; last: boolean }) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={entry.onPress}
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: roles.bgChip },
      ]}
    >
      <View style={styles.rowIcon}>{entry.icon}</View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowLabel, { color: roles.fg }]}>{entry.label}</Text>
        {entry.hint && (
          <Text style={[styles.rowHint, { color: roles.fgMuted }]}>
            {entry.hint}
          </Text>
        )}
      </View>
      {entry.badge ? (
        <View style={[styles.badge, { backgroundColor: roles.accent }]}>
          <Text style={[styles.badgeText, { color: roles.onAccent }]}>
            {entry.badge > 99 ? '99+' : entry.badge}
          </Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={16} color={roles.fgPlaceholder} />
    </Pressable>
  );
}

/** Het brand-kruis op icoon-formaat, zodat de gids-rij als Andreas leest. */
function Cross20({ color }: { color: string }) {
  return (
    <View style={styles.crossBox}>
      <View style={[styles.crossBar, { backgroundColor: color, transform: [{ rotate: '45deg' }] }]} />
      <View style={[styles.crossBar, { backgroundColor: color, transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  groupWrap: { paddingHorizontal: 22, paddingTop: 14 },
  groupLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingBottom: 8,
    paddingLeft: 2,
  },
  group: { borderRadius: 18, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowIcon: { width: 24, alignItems: 'center' },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 16,
    letterSpacing: -0.3,
  },
  rowHint: { fontFamily: fontFamily.body, fontSize: 13 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 999,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontFamily: fontFamily.medium, fontSize: 12 },
  crossBox: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  crossBar: { position: 'absolute', width: 20, height: 4, borderRadius: 1 },
});
