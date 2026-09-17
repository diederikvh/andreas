import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SearchOverlay } from '@/components/SearchOverlay';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered } from '@/lib/authClient';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  useFollowedArtists,
  useFollowedShows,
  useToggleArtistFollow,
} from '@/lib/queries';
import type { ApiFollowedShow } from '@/lib/api';
import { useRoles } from '@/store/mode';
import type { BadgeToneKey } from '@/theme/tones';
import { fontFamily } from '@/theme/tokens';

/**
 * Artiesten die je volgt, en wat daarvan eraan komt.
 *
 * In deze volgorde, met opzet. Een kale namenlijst open je één keer; de
 * reden om terug te komen is "wat staat er aan te komen van wie ik leuk
 * vind". Daarom bovenaan de avonden en pas daaronder wie je volgt.
 *
 * Het geeft de melding ook een thuis: krijg je bericht en tik je erop,
 * dan land je op het event, maar wil je het overzicht, dan is dit de
 * plek.
 */
export default function ArtiestenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();
  const { data: artists, isLoading: loadingArtists } = useFollowedArtists({
    enabled: authed,
  });
  const { data: shows, isLoading: loadingShows } = useFollowedShows({
    enabled: authed,
  });
  const toggle = useToggleArtistFollow();

  // De zoek hangt normaal aan de tabs, en dit scherm staat daarbuiten.
  // Vandaar een eigen exemplaar: zonder zoek is de lege staat een
  // opdracht zonder knop -- "zoek een artiest" en dan nergens heen.
  const [searchOpen, setSearchOpen] = useState(false);

  const headerButtons = (
    <View style={styles.headerRow}>
      <Pressable
        onPress={() => {
          softTap();
          setSearchOpen(true);
        }}
        hitSlop={8}
        style={styles.closeBtn}
        accessibilityLabel={t('Zoek een artiest', 'Search for an artist')}
      >
        <Ionicons name="search" size={19} color={roles.fg} />
      </Pressable>
      <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
        <Ionicons name="close" size={20} color={roles.fg} />
      </Pressable>
    </View>
  );
  const header = (
    <AppHeader
      title={t('Artiesten', 'Artists')}
      hideAvatar
      rightSlot={headerButtons}
    />
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={{ flex: 1, paddingTop: insets.top + HEADER_HEIGHT }}>
          <AccountWall
            icon="musical-notes-outline"
            title={t('Artiesten volgen', 'Following artists')}
            body={t(
              'Met een account onthouden we wie je volgt, en krijg je bericht zodra er een avond bij komt.',
              'With an account we remember who you follow, and you hear from us when a new night comes in.',
            )}
          />
        </View>
        {header}
      </View>
    );
  }

  const loading = loadingArtists || loadingShows;
  const nothing = !loading && (artists ?? []).length === 0;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {loading ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {nothing ? (
          <View style={styles.emptyWrap}>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {t(
                'Je volgt nog niemand. Zodra je iemand volgt hoor je het als er een avond bij komt.',
                'You are not following anyone yet. Once you follow someone, you hear from us when a new night comes in.',
              )}
            </Text>
            <Pressable
              onPress={() => {
                softTap();
                setSearchOpen(true);
              }}
              style={[styles.emptyBtn, { backgroundColor: roles.accent }]}
            >
              <Ionicons name="search" size={17} color={roles.onAccent} />
              <Text style={[styles.emptyBtnText, { color: roles.onAccent }]}>
                {t('Zoek een artiest', 'Search for an artist')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {(shows ?? []).length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: roles.accent }]}>
              {t('Komt eraan', 'Coming up')}
            </Text>
            {(shows ?? []).map((show) => (
              <FollowedShowRow key={show.id} show={show} />
            ))}
          </>
        ) : null}

        {(artists ?? []).length > 0 ? (
          <>
            <Text
              style={[
                styles.sectionTitle,
                { color: roles.accent, marginTop: 26 },
              ]}
            >
              {t('Je volgt', 'You follow')}
            </Text>
            {/* Geen komende avonden? Dan zegt dit lijstje dat we wél op de
                uitkijk staan -- dat is precies waarvoor je ze volgde. */}
            {(shows ?? []).length === 0 ? (
              <Text style={[styles.note, { color: roles.fgMuted }]}>
                {t(
                  'Nog niets aangekondigd. Zodra dat verandert hoor je het.',
                  'Nothing announced yet. You will hear from us when that changes.',
                )}
              </Text>
            ) : null}
            {(artists ?? []).map((artist) => (
              <Pressable
                key={artist.id}
                onPress={() => {
                  softTap();
                  router.push(`/artist/${artist.id}` as never);
                }}
                style={styles.artistRow}
              >
                <ProfileAvatar
                  avatarUrl={artist.imageUrl}
                  name={artist.name}
                  size={44}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text
                    numberOfLines={1}
                    style={[styles.artistName, { color: roles.fg }]}
                  >
                    {artist.name}
                  </Text>
                  {artist.genres.length > 0 ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.artistSub, { color: roles.fgMuted }]}
                    >
                      {artist.genres.slice(0, 2).join(' · ')}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => {
                    softTap();
                    toggle.mutate({ artistId: artist.id, following: false });
                  }}
                  hitSlop={10}
                  accessibilityLabel={t('Niet meer volgen', 'Unfollow')}
                >
                  <Ionicons name="close" size={18} color={roles.fgMuted} />
                </Pressable>
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>

      {header}

      <SearchOverlay
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </View>
  );
}

function FollowedShowRow({ show }: { show: ApiFollowedShow }) {
  const locale = useLocale();
  const venueTone =
    show.venue.type &&
    (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[show.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[show.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[show.category];
  // Een rij mag niet omvallen op een datum die niet te lezen is. Dat
  // gebeurde met een gecachet antwoord van vóór een serverfix: de datum
  // kwam als "2026-09-25 21:00:00+00" en JavaScriptCore op iOS maakt daar
  // een Invalid Date van. De server stuurt nu ISO, maar een scherm dat
  // crasht op oude data in de cache is alsnog stuk.
  const d = new Date(show.occurrence.startsAt);
  const dateLabel = Number.isNaN(d.getTime())
    ? undefined
    : `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
        d.getMonth(),
        locale,
      ).toLowerCase()}`;

  return (
    <EventListRow
      thumb={show.imageUrl ?? ''}
      thumbSize={96}
      title={show.title}
      venue={show.venue.name}
      venueTone={venueTone}
      time={rowTimeLabel(show.occurrence.startsAt, show.occurrence.endsAt, locale)}
      dateLabel={dateLabel}
      dateAbove
      tags={[{ label: translateCategory(show.category, locale), tone }]}
      // Waarom deze avond hier staat. Zonder dat is het een willekeurige
      // rij tussen je andere lijsten.
      genreLabel={show.artistName}
      tick={tone}
      onPress={() =>
        router.push(
          `/event/${show.id}?source=other&o=${show.occurrence.id}` as never,
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { paddingTop: 60, alignItems: 'center' },
  sectionTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.4,
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 6,
  },
  artistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 10,
  },
  artistName: { fontFamily: fontFamily.bold, fontSize: 15.5, letterSpacing: -0.2 },
  artistSub: { fontFamily: fontFamily.body, fontSize: 12.5 },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 22,
    paddingBottom: 6,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  emptyWrap: { paddingTop: 60, gap: 20 },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    textAlign: 'center',
  },
  emptyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 8,
  },
  emptyBtnText: { fontFamily: fontFamily.bold, fontSize: 15 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
