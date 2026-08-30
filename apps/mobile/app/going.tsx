/**
 * "Andreas ✕ Going" — full-screen lijst van events waar jij of je
 * vrienden naartoe gaan. Komt vroeger als sub-tab "Planning" op /social
 * te wonen; verhuisd naar 'n eigen scherm zodat hij vanaf de homepage-
 * shortcut bereikbaar is i.p.v. dieper in de social-tab.
 *
 * Inhoud merge'd `useMySaves` + `useSocialFeed` op occurrence-niveau
 * zodat één rij = "ik + de vrienden die ook gaan". Gevirtualizeerd via
 * SectionList (upcoming + past) want heavy users hebben honderden saves.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { RefreshBanner } from '@/components/RefreshBanner';
import { SpinningCross } from '@/components/SpinningCross';
import { useSession } from '@/lib/authClient';
import { type SavedApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useT, useLocale } from '@/lib/i18n';
import { useMyGoing } from '@/lib/queries';
import type { BadgeTone } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';


export default function GoingScreen() {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const qc = useQueryClient();

  // Anoniem mag: dit scherm gaat over jouw eigen agenda, niet over
  // andere mensen. Stond eerder achter `useIsRegistered()` toen het nog
  // "wie gaat waarheen" was — dat maakte de "Alles →"-knop op de
  // homepage-rail een doodlopende weg, want die rail werkt anoniem.
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: going, isLoading, error } = useMyGoing({ enabled: authed });

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    try {
      await qc.invalidateQueries({ queryKey: ['going'] });
    } finally {
      const elapsed = Date.now() - start;
      if (elapsed < 700) await new Promise((r) => setTimeout(r, 700 - elapsed));
      setRefreshing(false);
    }
  }, [qc]);

  const topInset = insets.top + HEADER_HEIGHT;
  const bottomInset = insets.bottom + 96;

  // Server geeft de lijst al gesorteerd (toekomst eerst), maar we
  // splitsen 'm hier alsnog: het verleden krijgt z'n eigen sectie met
  // een anker, en wordt gecapt op 7 dagen. "Oh ja, daar waren we vorige
  // week" is leuk; vorig jaar laat de lijst alleen groeien.
  const now = Date.now();
  const upcoming = useMemo(
    () =>
      (going ?? []).filter(
        (g) => new Date(g.endsAt ?? g.startsAt).getTime() >= now
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [going]
  );
  const past = useMemo(() => {
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    return (going ?? []).filter((g) => {
      const end = new Date(g.endsAt ?? g.startsAt).getTime();
      return end < now && end >= weekAgo;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [going]);

  const isEmpty =
    authed && !isLoading && !error && (going?.length ?? 0) === 0;

  const closeBtn = (
    <Pressable
      onPress={() => router.back()}
      hitSlop={8}
      style={[
        styles.closeBtn,
        { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
      ]}
    >
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <RefreshBanner visible={refreshing} topOffset={topInset + 8} />

      {isEmpty ? (
        <View
          style={[
            styles.emptyCenter,
            { paddingTop: topInset, paddingBottom: bottomInset },
          ]}
        >
          <Ionicons
            name="checkmark-circle-outline"
            size={48}
            color={roles.fgMuted}
          />
          <Text style={[styles.emptyTitle, { color: roles.fg }]}>
            {t('Nog niks op de planning.', 'Nothing planned yet.')}
          </Text>
          <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
            {t(
              'Zet bij een event "Ik ga hierheen" aan, dan staat het hier — en op je homepage.',
              'Turn on "I\u2019m going" at an event and it shows up here, and on your homepage.'
            )}
          </Text>
        </View>
      ) : isLoading ? (
        <View style={[styles.loadingWrap, { paddingTop: topInset }]}>
          <SpinningCross size={28} color={roles.fgPlaceholder} />
        </View>
      ) : error ? (
        <View style={[styles.listState, { paddingTop: topInset }]}>
          <Text style={[styles.listStateText, { color: '#c9453a' }]}>
            {t('Kon je planning niet laden.', 'Couldn’t load your planning.')}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={[
            ...(upcoming.length > 0
              ? [{ isPast: false, data: upcoming }]
              : []),
            ...(past.length > 0 ? [{ isPast: true, data: past }] : []),
          ]}
          keyExtractor={(item, idx) => `${idx}-${item.occurrenceId}`}
          renderItem={({ item, section }) => (
            <GoingRow entry={item} dim={section.isPast} />
          )}
          renderSectionHeader={({ section }) =>
            section.isPast ? <PastAnchor count={section.data.length} /> : null
          }
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{
            paddingTop: topInset,
            paddingBottom: bottomInset,
          }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={roles.accent}
              colors={[roles.accent]}
              progressViewOffset={topInset}
            />
          }
          windowSize={7}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          removeClippedSubviews
        />
      )}

      <AppHeader
        title={t('Going', 'Going')}
        hideAvatar
        rightSlot={closeBtn}
      />
    </View>
  );
}

function GoingRow({
  entry,
  dim = false,
}: {
  entry: SavedApiEvent;
  dim?: boolean;
}) {
  const locale = useLocale();
  const e = entry;
  const venue = entry.venue;
  const venueTone =
    venue.type && (VENUE_TYPE_TICK as Record<string, BadgeTone>)[venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeTone>)[venue.type]
      : undefined;
  const tone = CATEGORY_TICK[e.category];
  const d = new Date(entry.startsAt);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(entry.startsAt, entry.endsAt, locale);
  // Splits date + time: date gaat als label bóven de titel, time gaat
  // ook als kort label naar de rotated-tick rechts. Anders propt 'ie
  // de volledige string ("Fr 29 may · 20:00") in de smalle verticale
  // kolom — die croppt 'm tot "Fr 29..." en is onleesbaar.
  const dateLabel = `${dow} ${d.getDate()} ${month}`;
  return (
    <View style={dim ? { opacity: 0.5 } : undefined}>
      <EventListRow
        thumb={
          eventImageUrl({
            imageUrl: e.imageUrl ?? null,
            venue: { imageUrl: venue.imageUrl ?? null },
          }) ?? ''
        }
        thumbSize={96}
        title={e.title}
        venue={venue.name}
        venueTone={venueTone}
        time={time}
        dateLabel={dateLabel}
        dateAbove
        tags={[{ label: translateCategory(e.category, locale), tone }]}
        seriesLabel={undefined}
        genreLabel={(e.genres ?? [])[0]}
        tick={tone}
        onPress={() =>
          router.push(
            `/event/${entry.id}?source=going&o=${entry.occurrenceId}`
          )
        }
      />
    </View>
  );
}

function PastAnchor({ count }: { count: number }) {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={[styles.anchor, styles.pastAnchor]}>
      <Text style={[styles.pastLabel, { color: roles.fgMuted }]}>
        {t('Geweest', 'Past')}
      </Text>
      <Text style={[styles.anchorCount, { color: roles.fgPlaceholder }]}>
        {count} {count === 1 ? t('plan', 'plan') : t('plannen', 'plans')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyCenter: {
    flex: 1,
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 22,
    letterSpacing: -0.4,
    textAlign: 'center',
  },
  emptySub: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listState: { paddingHorizontal: 22, paddingVertical: 14 },
  listStateText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
  },
  anchor: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
    gap: 10,
  },
  pastAnchor: { marginTop: 22 },
  pastLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  anchorCount: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
});
