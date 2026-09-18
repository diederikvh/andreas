import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { EventListRow } from '@/components/EventListRow';
import { FILTER_ROW_HEIGHT, FilterChip } from '@/components/FilterChip';
import { SpinningCross } from '@/components/SpinningCross';
import { useIsRegistered } from '@/lib/authClient';
import { softTap } from '@/lib/haptics';
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
import { useMyGoing, useMySaves, useSocialFeed } from '@/lib/queries';
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
  /** Door mij geliked (het hartje). */
  liked: boolean;
  /** Door mij op "ik ga" gezet. Los van geliked: dat zijn twee knoppen
      en twee tabellen, en je kunt heel goed ergens heen gaan zonder het
      hartje te hebben aangetikt. */
  going: boolean;
  /** Vrienden die het leuk vinden. */
  friends: ApiFriendBadge[];
  /** Vrienden die er heen gaan. */
  friendsGoing: ApiFriendBadge[];
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
    liked: true,
    going: false,
    friends: e.friendsSaved ?? [],
    friendsGoing: [],
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
    liked: false,
    going: false,
    friends: e.friendsSaved ?? [],
    friendsGoing: e.friendsGoing ?? [],
  };
}

export default function SamenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();

  // Je eigen lijst werkt zonder account: een anonieme sessie heeft
  // gewoon saves. Alleen de vrienden-helft vraagt om een persoon, en dat
  // zegt de banner hierboven — in plaats van een muur voor een lijst die
  // je wél mag zien.
  const { data: saves, isLoading: loadingSaves } = useMySaves();
  const { data: going, isLoading: loadingGoing } = useMyGoing({ enabled: authed });
  const { data: feed, isLoading: loadingFeed } = useSocialFeed({ enabled: authed });

  const rows = useMemo<Row[]>(() => {
    const now = Date.now();
    const byOccurrence = new Map<string, Row>();
    // Mijn eigen likes eerst: die bepalen `liked`. Een avond die een
    // vriend óók likete, vult z'n vrienden erbij in plaats van een
    // tweede rij te maken.
    for (const e of saves ?? []) {
      byOccurrence.set(e.occurrenceId, fromSave(e));
    }
    // Waar ik heen ga staat in een eigen tabel en hoeft niet geliked te
    // zijn, dus dit zet ook rijen bij die er anders niet waren.
    for (const e of going ?? []) {
      const existing = byOccurrence.get(e.occurrenceId);
      if (existing) existing.going = true;
      else byOccurrence.set(e.occurrenceId, { ...fromSave(e), liked: false, going: true });
    }
    for (const e of feed ?? []) {
      const existing = byOccurrence.get(e.occurrence.id);
      if (existing) {
        const known = new Set(
          [...existing.friends, ...existing.friendsGoing].map((f) => f.id),
        );
        existing.friends = [
          ...existing.friends,
          ...(e.friendsSaved ?? []).filter((f) => !known.has(f.id)),
        ];
        existing.friendsGoing = [
          ...existing.friendsGoing,
          ...(e.friendsGoing ?? []).filter((f) => !known.has(f.id)),
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
  }, [saves, going, feed]);

  /**
   * Vier filters die je kunt combineren, geen tabs.
   *
   * Twee vragen door elkaar: *wie* (ik, vrienden) en *wat* (gaat er
   * heen, vindt het leuk). Niets aangetikt in een dimensie betekent
   * "maakt niet uit", dus "Ik ga" alleen toont alles waar iemand heen
   * gaat, en "Ik ga" plus "Vrienden" toont waar je vrienden heen gaan.
   * Dat is de vraag die je stelt als je je ergens bij wil aansluiten.
   *
   * Geen chip per vriend: bij dertig vrienden is dat dertig chips en
   * scroll je door een rij die geen antwoord geeft. Eén knop vrienden
   * zegt hetzelfde, en wie het precies zijn staat in de rij zelf.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    softTap();
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const matches = (r: Row, keys: Set<string>) => {
    const anyWho = !keys.has('me') && !keys.has('friends');
    const anyWhat = !keys.has('going') && !keys.has('liked');
    const me = anyWho || keys.has('me');
    const friends = anyWho || keys.has('friends');
    const going = anyWhat || keys.has('going');
    const liked = anyWhat || keys.has('liked');
    return (
      (me && going && r.going) ||
      (me && liked && r.liked) ||
      (friends && going && r.friendsGoing.length > 0) ||
      (friends && liked && r.friends.length > 0)
    );
  };

  const shown = useMemo(
    () => rows.filter((r) => matches(r, picked)),
    [rows, picked],
  );
  // Wat deze chip op zichzelf zou opleveren. Voorspelbaarder dan een
  // getal dat meebeweegt met wat er verder aanstaat.
  const count = (key: string) =>
    rows.filter((r) => matches(r, new Set([key]))).length;

  const closeBtn = (
    <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  const loading = loadingSaves || (authed && (loadingFeed || loadingGoing));

  // Geen filterrij bij een lege lijst: dan is er niets om uit te
  // filteren en staat er alleen een rij chips boven een uitleg.
  const chips =
    rows.length > 0 ? (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {/* "Alles" wist de selectie in plaats van een eigen stand te
            zijn: met niets aangetikt zie je toch al alles, dus hij doet
            niets nieuws -- hij maakt alleen de uitweg zichtbaar. */}
        <FilterChip
          label={t('Alles', 'All')}
          count={rows.length}
          active={picked.size === 0}
          onPress={() => {
            softTap();
            setPicked(new Set());
          }}
        />
        <FilterChip
          label={t('Ik ga', 'Going')}
          count={count('going')}
          active={picked.has('going')}
          onPress={() => toggle('going')}
        />
        <FilterChip
          label={t('Geliked', 'Liked')}
          count={count('liked')}
          active={picked.has('liked')}
          onPress={() => toggle('liked')}
        />
        <FilterChip
          label={t('Van mij', 'You')}
          count={count('me')}
          active={picked.has('me')}
          onPress={() => toggle('me')}
        />
        <FilterChip
          label={t('Vrienden', 'Friends')}
          count={count('friends')}
          active={picked.has('friends')}
          onPress={() => toggle('friends')}
        />
      </ScrollView>
    ) : null;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          // Zelfde rekensom als op de agenda: de chip-rij zit vast in de
          // header, dus de content begint eronder.
          paddingTop: chips
            ? insets.top + HEADER_HEIGHT + FILTER_ROW_HEIGHT + 10
            : insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 96,
        }}
      >
        {/* Geen muur maar een uitnodiging: wat je hebt zie je gewoon,
            en dit zegt wat erbij komt. Eén keer bovenaan, niet tussen de
            rijen — het is een mededeling, geen rij. */}
        {!authed ? (
          <Pressable
            onPress={() => {
              softTap();
              router.push('/jij' as never);
            }}
            style={[styles.banner, { backgroundColor: roles.bgChip }]}
          >
            <View
              style={[
                styles.bannerIcon,
                { backgroundColor: `${roles.accent}22` },
              ]}
            >
              <Ionicons name="people" size={18} color={roles.accent} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[styles.bannerTitle, { color: roles.fg }]}>
                {t('Ook zien wat zij reden?', 'See what they saved too?')}
              </Text>
              <Text style={[styles.bannerText, { color: roles.fgMuted }]}>
                {t(
                  'Dit is nu alleen jouw lijst. Met een account komen je vrienden erbij.',
                  'This is just your list for now. With an account your friends join in.',
                )}
              </Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={roles.fgPlaceholder}
            />
          </Pressable>
        ) : null}

        {loading && rows.length === 0 ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {!loading && rows.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {authed
              ? t(
                  'Nog niets geliked — door jou niet en door je vrienden niet. Tik op het hartje bij een avond en hij staat hier.',
                  'Nothing saved yet — not by you and not by your friends. Tap the heart on a night and it will be here.',
                )
              : t(
                  'Nog niets geliked. Tik op het hartje bij een avond en hij staat hier.',
                  'Nothing saved yet. Tap the heart on a night and it will be here.',
                )}
          </Text>
        ) : null}

        {rows.length > 0 && shown.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t('Niets in deze selectie.', 'Nothing in this selection.')}
          </Text>
        ) : null}

        {shown.map((row) => (
          <SamenRow key={row.occurrenceId} row={row} />
        ))}
      </ScrollView>

      <AppHeader
        title={t('Favorieten', 'Favourites')}
        hideAvatar
        rightSlot={closeBtn}
      >
        {chips}
      </AppHeader>
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

  // Gaan eerst in de pill, dan wie het leuk vindt. De pill zegt nog niet
  // welke van de twee iemand is -- dat vraagt een tweede pill-vorm en
  // dat is een eigen ontwerp.
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
        [...row.friendsGoing, ...row.friends].length > 0
          ? [...row.friendsGoing, ...row.friends].map((f) => ({
              name: f.name,
              avatar: f.avatarUrl,
            }))
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
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 6,
    height: FILTER_ROW_HEIGHT,
  },
  center: { paddingTop: 60, alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 22,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  bannerIcon: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  bannerText: { fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 17 },
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
