import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered } from '@/lib/authClient';
import type { ApiFeedEvent, ApiFriendBadge, SavedApiEvent } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  eventImageUrl,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { useMySaves, useSocialFeed } from '@/lib/queries';
import { useRoles } from '@/store/mode';
import type { BadgeToneKey } from '@/theme/tones';
import { fontFamily } from '@/theme/tokens';

/**
 * Wat jij en je vrienden hebben gered.
 *
 * Verving "Voor jou" in het Meer-menu. Dat scherm deed aanbevelingen op
 * basis van smaak, en de vraag die het beantwoordde — "wat zou je leuk
 * vinden?" — is niet de vraag die Diederik stelt. Die is: wat vinden wij
 * leuk. Geen model, geen score: twee lijsten die we al hebben, op
 * occurrence-niveau samengevoegd.
 *
 * Eén rij per avond. Heb jij 'm gered én twee vrienden ook, dan is dat
 * één regel met een vrienden-pil, niet drie.
 */

/** Eén avond, en wie 'm leuk vindt. */
type Row = {
  eventId: string;
  occurrenceId: string;
  title: string;
  category: SavedApiEvent['category'];
  genres: string[];
  imageUrl: string | null;
  venue: { name: string; type?: string | null; imageUrl?: string | null };
  startsAt: string;
  endsAt: string | null;
  mine: boolean;
  friends: ApiFriendBadge[];
};

function fromSave(e: SavedApiEvent): Row {
  return {
    eventId: e.id,
    occurrenceId: e.occurrenceId,
    title: e.title,
    category: e.category,
    genres: e.genres ?? [],
    imageUrl: e.imageUrl ?? null,
    venue: {
      name: e.venue.name,
      type: e.venue.type ?? null,
      imageUrl: e.venue.imageUrl ?? null,
    },
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    mine: true,
    friends: e.friendsSaved ?? [],
  };
}

function fromFeed(e: ApiFeedEvent): Row {
  return {
    eventId: e.eventId,
    occurrenceId: e.occurrence.id,
    title: e.title,
    category: e.category,
    genres: e.genres ?? [],
    imageUrl: e.imageUrl ?? null,
    venue: {
      name: e.venue.name,
      type: e.venue.type ?? null,
      imageUrl: e.venue.imageUrl ?? null,
    },
    startsAt: e.occurrence.startsAt,
    endsAt: e.occurrence.endsAt,
    mine: false,
    friends: e.friendsSaved ?? [],
  };
}

export default function SamenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();

  const { data: saves, isLoading: loadingSaves } = useMySaves({ enabled: authed });
  const { data: feed, isLoading: loadingFeed } = useSocialFeed({ enabled: authed });

  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    const byOccurrence = new Map<string, Row>();
    // Mijn eigen saves eerst: die bepalen `mine`. Een avond die een
    // vriend óók reed, vult z'n vrienden erbij in plaats van een tweede
    // rij te maken.
    for (const e of saves ?? []) {
      byOccurrence.set(e.occurrenceId, fromSave(e));
    }
    for (const e of feed ?? []) {
      const existing = byOccurrence.get(e.occurrence.id);
      if (existing) {
        const known = new Set(existing.friends.map((f) => f.id));
        existing.friends = [
          ...existing.friends,
          ...(e.friendsSaved ?? []).filter((f) => !known.has(f.id)),
        ];
      } else {
        byOccurrence.set(e.occurrence.id, fromFeed(e));
      }
    }
    return [...byOccurrence.values()]
      .filter((r) => new Date(r.endsAt ?? r.startsAt).getTime() >= now)
      .sort(
        (a, b) =>
          new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
      );
  }, [saves, feed]);

  const closeBtn = (
    <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <AccountWall
          title={t('Jij & vrienden', 'You & friends')}
          body={t(
            'Hiervoor moet Andreas weten wie je vrienden zijn.',
            'For this, Andreas needs to know who your friends are.',
          )}
        />
        <AppHeader
          title={t('Jij & vrienden', 'You & friends')}
          hideAvatar
          rightSlot={closeBtn}
        />
      </View>
    );
  }

  const loading = loadingSaves || loadingFeed;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {loading && rows.length === 0 ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {!loading && rows.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t(
              'Nog niets gered — door jou niet en door je vrienden niet. Tik op het hartje bij een avond en hij staat hier.',
              'Nothing saved yet — not by you and not by your friends. Tap the heart on a night and it will be here.',
            )}
          </Text>
        ) : null}

        {rows.map((row) => (
          <SamenRow key={row.occurrenceId} row={row} />
        ))}
      </ScrollView>

      <AppHeader
          title={t('Jij & vrienden', 'You & friends')}
          hideAvatar
          rightSlot={closeBtn}
        />
    </View>
  );
}

function SamenRow({ row }: { row: Row }) {
  const locale = useLocale();
  const venueTone =
    row.venue.type &&
    (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[row.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[row.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[row.category];
  const d = new Date(row.startsAt);
  const dateLabel = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
    d.getMonth(),
    locale,
  ).toLowerCase()}`;

  return (
    <EventListRow
      thumb={
        eventImageUrl({
          imageUrl: row.imageUrl,
          venue: { imageUrl: row.venue.imageUrl ?? null },
        }) ?? ''
      }
      thumbSize={96}
      title={row.title}
      venue={row.venue.name}
      venueTone={venueTone}
      time={rowTimeLabel(row.startsAt, row.endsAt, locale)}
      dateLabel={dateLabel}
      dateAbove
      tags={[{ label: translateCategory(row.category, locale), tone }]}
      genreLabel={(row.genres ?? [])[0]}
      friends={
        row.friends.length > 0
          ? row.friends.map((f) => ({ name: f.name, avatar: f.avatarUrl }))
          : undefined
      }
      tick={tone}
      onPress={() =>
        router.push(`/event/${row.eventId}?source=going&o=${row.occurrenceId}`)
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { paddingTop: 60, alignItems: 'center' },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    paddingTop: 60,
    textAlign: 'center',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
