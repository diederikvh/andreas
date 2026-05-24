import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BackButton } from '@/components/BackButton';
import { EventListRow } from '@/components/EventListRow';
import type { ApiEvent, ApiInvitation } from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  eventImageUrl,
  CATEGORY_TICK,
  type EventGroup,
  dowMixed,
  monthShort,
  rowTimeLabel,
  groupEventsByDay,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import {
  useFriend,
  useInvitations,
  useMirrorByHandle,
  useRemoveFriend,
  useSetFriendFavorite,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

type Tab = 'profiel' | 'samen';

export default function FriendDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId ?? '';
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();

  const { data, isLoading, error } = useFriend(id);
  const { data: session } = useSession();
  const myId = session?.user?.id ?? null;
  const { data: invitations } = useInvitations();
  const removeFriend = useRemoveFriend();
  const setFavorite = useSetFriendFavorite(id);
  const [tab, setTab] = useState<Tab>('profiel');

  // Invites tussen mij en deze friend: beide partijen hebben een
  // response-rij op dezelfde invitation. Dekt 1-op-1's én groep-invites
  // waarin we beide zitten. Filter niet-verlopen, sorteer toekomstige
  // events eerst (chronologisch).
  const samenInvites: ApiInvitation[] = (() => {
    if (!invitations || !myId) return [];
    return invitations
      .filter((inv) => {
        if (inv.revokedAt) return false;
        const meIn = inv.responses.some((r) => r.user.id === myId);
        const friendIn = inv.responses.some((r) => r.user.id === id);
        return meIn && friendIn;
      })
      .sort(
        (a, b) =>
          new Date(a.occurrence.startsAt).getTime() -
          new Date(b.occurrence.startsAt).getTime()
      );
  })();
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);

  const handle = data?.user.handle ?? null;
  const mirror = useMirrorByHandle(handle, { enabled: tab === 'profiel' });

  const confirmUnfollow = () => {
    if (!data) return;
    const name =
      data.user.name ||
      (data.user.handle
        ? `@${data.user.handle}`
        : t('deze vriend', 'this friend'));
    Alert.alert(
      t('Niet meer volgen', 'Unfollow'),
      t(
        `${name} verwijderen uit je vrienden?`,
        `Remove ${name} from your friends?`
      ),
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Niet meer volgen', 'Unfollow'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFriend.mutateAsync(id);
              router.back();
            } catch {
              Alert.alert(
                t('Mislukt', 'Failed'),
                t(
                  'Kon niet ontvolgen. Probeer opnieuw.',
                  'Couldn’t unfriend. Try again.'
                )
              );
            }
          },
        },
      ]
    );
  };

  const openRelationMenu = () => setMenuOpen(true);
  const closeRelationMenu = () => setMenuOpen(false);

  if (isLoading) {
    return (
      <View
        style={[
          styles.root,
          styles.center,
          { backgroundColor: roles.bg, paddingTop: insets.top + 32 },
        ]}
      >
        <ActivityIndicator color={roles.fgMuted} />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
          <BackButton />
        </View>
        <View style={styles.center}>
          <Text style={[styles.errorText, { color: '#c9453a' }]}>
            {t('Profiel niet beschikbaar.', 'Profile not available.')}
          </Text>
        </View>
      </View>
    );
  }

  const { user, events, savesPrivate } = data;
  const upcoming = events.filter(
    (e) => new Date(e.endsAt ?? e.startsAt).getTime() >= Date.now()
  );
  const upcomingDays: EventGroup[] = groupEventsByDay(upcoming);

  // Welke tabs zijn relevant? Alleen tabs tonen als zowel saves als
  // spiegel iets te bieden hebben. Anders skippen we de pill-switch
  // en tonen we direct de enige beschikbare pane (of een lege state
  // als niemand iets deelt).
  const savesShared = !savesPrivate;
  const mirrorShared = Boolean(data.mirrorShared);
  const profielHasContent = mirrorShared || savesShared;
  const samenHasContent = samenInvites.length > 0;
  // Tabs alleen tonen wanneer er minstens twee panes content hebben.
  // Als enkel Profiel of enkel Samen iets bevat, renderen we die pane
  // direct zonder switch — minder klikken, geen dode tab-pill.
  const showTabs = profielHasContent && samenHasContent;
  const effectiveTab: Tab = showTabs
    ? tab
    : profielHasContent
      ? 'profiel'
      : 'samen';

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 32,
        }}
      >
        <View style={styles.topBar}>
          <BackButton />
        </View>

        <View style={styles.head}>
          {user.avatarUrl ? (
            <Pressable
              onPress={() => setAvatarOpen(true)}
              accessibilityLabel={t('Foto vergroten', 'Zoom photo')}
            >
              <Image
                source={{ uri: user.avatarUrl }}
                style={[styles.avatar, { borderColor: roles.bgChip }]}
                contentFit="cover"
              />
            </Pressable>
          ) : (
            <View
              style={[
                styles.avatar,
                styles.avatarFallback,
                {
                  borderColor: roles.bgChip,
                  backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                },
              ]}
            >
              <Text style={[styles.avatarInitial, { color: roles.fgMuted }]}>
                {(user.name.trim()[0] ?? '?').toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={[styles.name, { color: roles.fg }]}>{user.name}</Text>
          {user.handle && (
            <Text style={[styles.handle, { color: roles.fgMuted }]}>
              @{user.handle}
            </Text>
          )}
          <RelationButton
            favorite={Boolean(data.favorite)}
            busy={setFavorite.isPending || removeFriend.isPending}
            onPress={openRelationMenu}
          />
        </View>

        {showTabs && <FriendSubTabs tab={effectiveTab} onChange={setTab} />}

        {effectiveTab === 'profiel' && (
          <>
            {mirrorShared && (
              <MirrorPane
                name={user.name}
                data={mirror.data ?? null}
                loading={mirror.isLoading}
                errored={Boolean(mirror.error)}
              />
            )}

            {/* Divider alleen wanneer beide blokken iets renderen — anders
                hangt-ie los boven of onder een lege ruimte. */}
            {mirrorShared && savesShared && (
              <View
                style={[
                  styles.sectionDivider,
                  { borderTopColor: roles.bgChip },
                ]}
              />
            )}

            {savesShared && (
              <>
                {upcomingDays.length === 0 && (
                  <Text style={[styles.empty, { color: roles.fgMuted }]}>
                    {t('Nog niks geliket.', 'Nothing liked yet.')}
                  </Text>
                )}
                {upcomingDays.map((day) => (
                  <View key={`up-${day.id}`}>
                    <DateAnchor group={day} />
                    {day.events.map((e) => (
                      <FriendSavedRow key={e.id} event={e} />
                    ))}
                  </View>
                ))}
              </>
            )}
          </>
        )}

        {effectiveTab === 'samen' && (
          <SamenPane
            invites={samenInvites}
            friendId={id}
            friendName={user.name}
            myId={myId}
          />
        )}
      </ScrollView>

      {user.avatarUrl ? (
        <Modal
          visible={avatarOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setAvatarOpen(false)}
          statusBarTranslucent
        >
          <Pressable
            onPress={() => setAvatarOpen(false)}
            style={styles.lightboxBackdrop}
            accessibilityLabel={t('Sluiten', 'Close')}
          >
            <Image
              source={{ uri: user.avatarUrl }}
              style={styles.lightboxImage}
              contentFit="contain"
            />
          </Pressable>
        </Modal>
      ) : null}

      <RelationDrawer
        open={menuOpen}
        favorite={Boolean(data.favorite)}
        onClose={closeRelationMenu}
        onPickFavorite={() => {
          closeRelationMenu();
          setFavorite.mutate(true);
        }}
        onPickFollowing={() => {
          closeRelationMenu();
          setFavorite.mutate(false);
        }}
        onPickUnfollow={() => {
          closeRelationMenu();
          confirmUnfollow();
        }}
      />
    </View>
  );
}

function RelationDrawer({
  open,
  favorite,
  onClose,
  onPickFavorite,
  onPickFollowing,
  onPickUnfollow,
}: {
  open: boolean;
  favorite: boolean;
  onClose: () => void;
  onPickFavorite: () => void;
  onPickFollowing: () => void;
  onPickUnfollow: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={drawerStyles.backdropWrap}>
        <Pressable
          accessibilityLabel={t('Sluiten', 'Close')}
          onPress={onClose}
          style={drawerStyles.backdrop}
        />
        <View
          style={[
            drawerStyles.sheet,
            {
              backgroundColor: isNacht ? palette.noir2 : palette.paper3,
              paddingBottom: insets.bottom + 12,
              borderTopColor: roles.bgChip,
            },
          ]}
        >
          <View
            style={[drawerStyles.handle, { backgroundColor: roles.bgChip }]}
          />
          <DrawerRow
            icon={favorite ? 'star' : 'star-outline'}
            iconColor={favorite ? roles.accent : roles.fg}
            label={t('Favoriet', 'Favourite')}
            hint={
              favorite
                ? t('Geselecteerd', 'Selected')
                : t('Markeer als favoriet', 'Mark as favourite')
            }
            selected={favorite}
            onPress={onPickFavorite}
          />
          <DrawerRow
            icon={!favorite ? 'person' : 'person-outline'}
            iconColor={roles.fg}
            label={t('Volgend', 'Following')}
            hint={
              !favorite
                ? t('Geselecteerd', 'Selected')
                : t('Verwijder uit favorieten', 'Remove from favourites')
            }
            selected={!favorite}
            onPress={onPickFollowing}
          />
          <View
            style={[
              drawerStyles.divider,
              { backgroundColor: roles.bgChip },
            ]}
          />
          <DrawerRow
            icon="person-remove-outline"
            iconColor={isNacht ? palette.flare : palette.red}
            labelColor={isNacht ? palette.flare : palette.red}
            label={t('Niet meer volgen', 'Unfollow')}
            onPress={onPickUnfollow}
          />
        </View>
      </View>
    </Modal>
  );
}

function DrawerRow({
  icon,
  iconColor,
  label,
  labelColor,
  hint,
  selected,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconColor: string;
  label: string;
  labelColor?: string;
  hint?: string;
  selected?: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        drawerStyles.row,
        pressed && { backgroundColor: roles.bgChip },
      ]}
    >
      <Ionicons name={icon} size={20} color={iconColor} />
      <View style={drawerStyles.rowBody}>
        <Text
          style={[drawerStyles.rowLabel, { color: labelColor ?? roles.fg }]}
        >
          {label}
        </Text>
        {hint ? (
          <Text style={[drawerStyles.rowHint, { color: roles.fgMuted }]}>
            {hint}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Ionicons name="checkmark" size={18} color={roles.fg} />
      ) : null}
    </Pressable>
  );
}

const drawerStyles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
  },
  rowBody: { flex: 1 },
  rowLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 15,
    letterSpacing: -0.15,
  },
  rowHint: {
    marginTop: 2,
    fontFamily: fontFamily.body,
    fontSize: 12,
    letterSpacing: -0.05,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 4,
    marginHorizontal: 16,
  },
});

function RelationButton({
  favorite,
  busy,
  onPress,
}: {
  favorite: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  const t = useT();
  const label = favorite
    ? t('Favoriet', 'Favourite')
    : t('Volgend', 'Following');
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityLabel={label}
      style={[
        styles.relationBtn,
        {
          borderColor: roles.bgChip,
          backgroundColor: 'transparent',
          opacity: busy ? 0.5 : 1,
        },
      ]}
    >
      <Ionicons
        name={favorite ? 'star' : 'person'}
        size={14}
        color={favorite ? roles.accent : roles.fg}
      />
      <Text style={[styles.relationBtnText, { color: roles.fg }]}>{label}</Text>
      <Ionicons name="chevron-down" size={14} color={roles.fgMuted} />
    </Pressable>
  );
}

function FriendSubTabs({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (next: Tab) => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const t = useT();
  const [trackW, setTrackW] = useState(0);
  const activeIndex = tab === 'profiel' ? 0 : 1;
  const progress = useSharedValue(activeIndex);
  useEffect(() => {
    progress.value = withTiming(activeIndex, {
      duration: 240,
      easing: Easing.bezier(0.65, 0, 0.35, 1),
    });
  }, [activeIndex, progress]);
  const blobStyle = useAnimatedStyle(() => {
    const inner = Math.max(0, trackW - 6);
    const w = inner / 2;
    return { width: w, transform: [{ translateX: progress.value * w }] };
  });

  return (
    <View style={styles.subTabsAlign}>
      <View
        style={[styles.switchTrack, { borderColor: roles.bgChip }]}
        onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      >
        <BlurView
          intensity={40}
          tint={mode === 'nacht' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor:
                mode === 'nacht'
                  ? 'rgba(23,23,26,0.65)'
                  : 'rgba(235,230,216,0.7)',
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.switchBlob,
            blobStyle,
            { backgroundColor: roles.accent },
          ]}
        />
        <SwitchBtn
          label={t('Profiel', 'Profile')}
          active={tab === 'profiel'}
          onPress={() => onChange('profiel')}
        />
        <SwitchBtn
          label={t('Samen', 'Together')}
          active={tab === 'samen'}
          onPress={() => onChange('samen')}
        />
      </View>
    </View>
  );
}

function SwitchBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  const tint = active ? roles.onAccent : roles.fgMuted;
  return (
    <Pressable onPress={onPress} style={styles.switchBtn}>
      <Text style={[styles.switchBtnText, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function MirrorPane({
  name,
  data,
  loading,
  errored,
}: {
  name: string;
  data: { topVenues: { id: string; slug: string; name: string }[]; topGenres: { genre: string }[] } | null;
  loading: boolean;
  errored: boolean;
}) {
  const roles = useRoles();
  const t = useT();
  const firstName = name.split(' ')[0];

  if (loading) {
    return (
      <View style={[styles.center, { paddingVertical: 32 }]}>
        <ActivityIndicator color={roles.fgMuted} />
      </View>
    );
  }
  if (errored || !data) {
    return (
      <Text style={[styles.empty, { color: roles.fgMuted }]}>
        {t(
          `${firstName} deelt z'n profielinzicht niet.`,
          `${firstName} doesn’t share their profile insight.`
        )}
      </Text>
    );
  }
  if (data.topVenues.length === 0 && data.topGenres.length === 0) {
    return (
      <Text style={[styles.empty, { color: roles.fgMuted }]}>
        {t('Nog niks om te tonen.', 'Nothing to show yet.')}
      </Text>
    );
  }
  return (
    <View style={styles.mirrorWrap}>
      {data.topVenues.length > 0 && (
        <View style={styles.mirrorBlock}>
          <Text style={[styles.mirrorBlockTitle, { color: roles.fg }]}>
            {t('Top venues', 'Top venues')}
          </Text>
          <View style={styles.mirrorChipsRow}>
            {data.topVenues.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => router.push(`/venue/${v.slug}` as never)}
                style={[styles.mirrorChip, { backgroundColor: roles.bgTag }]}
              >
                <Text style={[styles.mirrorChipLabel, { color: roles.fg }]}>
                  {v.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {data.topGenres.length > 0 && (
        <View style={styles.mirrorBlock}>
          <Text style={[styles.mirrorBlockTitle, { color: roles.fg }]}>
            {t('Genres', 'Genres')}
          </Text>
          <View style={styles.mirrorChipsRow}>
            {data.topGenres.map((g) => (
              <Pressable
                key={g.genre}
                onPress={() =>
                  router.push({
                    pathname: '/(tabs)/agenda',
                    params: { q: g.genre },
                  })
                }
                style={[styles.mirrorChip, { backgroundColor: roles.bgTag }]}
              >
                <Text style={[styles.mirrorChipLabel, { color: roles.fg }]}>
                  {g.genre}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function DateAnchor({ group }: { group: EventGroup }) {
  const roles = useRoles();
  return (
    <View style={styles.anchor}>
      <View style={styles.anchorLeft}>
        <Text style={[styles.anchorDow, { color: roles.fg }]}>
          {group.dow} {group.num}
        </Text>
        <Text style={[styles.anchorMonth, { color: roles.fgMuted }]}>
          {group.month}
        </Text>
      </View>
    </View>
  );
}

/**
 * Lijst met invitations tussen mij en deze friend. Dekt 1-op-1's (in
 * beide richtingen) én groep-invites waarin we beide zitten. Per rij:
 *
 *  - EventListRow met datum boven titel + categorie/venue tags + avatar-
 *    stack van going-respondenten (sociale bewijslast).
 *  - Onder de row een korte status-zin: hoeveel van het totaal gaat én
 *    de status van de friend zelf wanneer die afwijkt van going.
 *
 * Tap → /invitation/[id] voor het volle overzicht per status.
 */
function SamenPane({
  invites,
  friendId,
  friendName,
  myId,
}: {
  invites: ApiInvitation[];
  friendId: string;
  friendName: string;
  myId: string | null;
}) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();
  const friendFirst = friendName.split(' ')[0] || friendName;

  if (invites.length === 0) {
    return (
      <Text style={[styles.empty, { color: roles.fgMuted }]}>
        {t(
          `Nog niks samen met ${friendFirst}. Nodig ze uit voor een event om hier te zien wat er speelt.`,
          `Nothing planned with ${friendFirst} yet. Invite them to an event to fill this in.`
        )}
      </Text>
    );
  }

  return (
    <>
      {invites.map((inv) => {
        const d = new Date(inv.occurrence.startsAt);
        const dow = dowMixed(d.getDay(), locale);
        const month = monthShort(d.getMonth(), locale).toLowerCase();
        const time = rowTimeLabel(
          inv.occurrence.startsAt,
          inv.occurrence.endsAt,
          locale
        );
        const dateLabel = `${dow} ${d.getDate()} ${month} · ${time}`;

        // Friend's eigen response — gebruikt voor de "Roos: misschien"-
        // zin onder de row wanneer hij/zij niet going is.
        const friendResp = inv.responses.find((r) => r.user.id === friendId);
        const friendStatus = friendResp?.status ?? 'pending';

        // Going-stack: alle responses met status 'going', uitgezonderd
        // mijzelf — die hoef ik niet in mijn eigen overzicht te zien.
        // Friend gaat vooraan zodat 'ie meteen herkenbaar is.
        const goingAll = inv.responses
          .filter((r) => r.status === 'going' && r.user.id !== myId)
          .sort((a, b) =>
            a.user.id === friendId ? -1 : b.user.id === friendId ? 1 : 0
          );
        const goingFriends = goingAll.slice(0, 3).map((r) => ({
          name: r.user.name,
          avatar: r.user.avatarUrl,
        }));

        // Compacte going-counter: "1/4 gaan" — verder geen extra info,
        // detail staat op /invitation/[id] één tap verder.
        const totalGoing = inv.responses.filter(
          (r) => r.status === 'going'
        ).length;
        const totalCount = inv.responses.length;
        const summary = t(
          `${totalGoing}/${totalCount} gaan`,
          `${totalGoing}/${totalCount} going`
        );
        // Unused-warn voorkomen — friendStatus blijft beschikbaar voor
        // toekomstige UI-tweaks (bv. friend-only status-pill).
        void friendStatus;

        return (
          <EventListRow
            key={inv.id}
            time={dateLabel}
            dateAbove
            thumb={
              eventImageUrl({
                imageUrl: inv.event.imageUrl,
                venue: { imageUrl: null },
              }) ?? ''
            }
            thumbSize={96}
            title={inv.event.title}
            venue=""
            tags={[
              {
                label: translateCategory(inv.event.category, locale),
                tone: CATEGORY_TICK[inv.event.category],
              },
              {
                label: inv.event.venueName,
                tone: CATEGORY_TICK[inv.event.category],
              },
              {
                // Going-counter aan dezelfde tag-rij, "acid"-tone (geel in
                // nacht, donker-geel in dag) zodat 'ie eruit springt
                // tegen de category/venue-tags.
                label: summary,
                tone: 'acid',
              },
            ]}
            friends={goingFriends.length > 0 ? goingFriends : undefined}
            tick={CATEGORY_TICK[inv.event.category]}
            onPress={() =>
              router.push(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                `/invitation/${inv.id}` as any
              )
            }
          />
        );
      })}
    </>
  );
}

function FriendSavedRow({ event }: { event: ApiEvent }) {
  const locale = useLocale();
  return (
    <EventListRow
      time={rowTimeLabel(event.startsAt, event.endsAt, locale)}
      thumb={eventImageUrl(event) ?? ''}
      thumbSize={96}
      title={event.title}
      venue={event.nextOccurrenceVenue?.name ?? event.venue.name}
      tags={[
        {
          label: translateCategory(event.category, locale),
          tone: CATEGORY_TICK[event.category],
        },
      ]}
      seriesLabel={event.series?.[0]?.name}
      genreLabel={event.genres?.[0]}
      tick={CATEGORY_TICK[event.category]}
      onPress={() => router.push(`/event/${event.id}?source=friend`)}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.5,
  },

  topBar: {
    paddingHorizontal: 18,
    paddingBottom: 8,
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  lightboxImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 12,
  },
  relationBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
  },
  relationBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.1,
  },

  head: {
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 8,
  },
  avatar: {
    width: 96,
    height: 96,
    borderRadius: 999,
    borderWidth: 2,
  },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: {
    fontFamily: fontFamily.display,
    fontSize: 40,
    letterSpacing: -1,
  },
  name: {
    fontFamily: fontFamily.display,
    fontSize: 26,
    letterSpacing: -0.65,
    lineHeight: 26 * 1.02,
    marginTop: 4,
    textAlign: 'center',
  },
  handle: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Sub-tabs — pill-switch met blur, gelijk aan Social.
  subTabsAlign: {
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 12,
  },
  switchTrack: {
    flexDirection: 'row',
    padding: 3,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  switchBlob: {
    position: 'absolute',
    top: 3,
    left: 3,
    bottom: 3,
    borderRadius: 999,
  },
  switchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
  switchBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: -0.06,
  },

  empty: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  // Hairline-divider tussen profielinzicht- en likes-secties in de
  // Profiel-tab. Marginhorizontal = paginakanten zodat de lijn netjes
  // tot dezelfde gutter loopt als de rij-content.
  sectionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 22,
    marginTop: 28,
    marginBottom: 20,
  },

  anchor: {
    flexDirection: 'row',
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 6,
  },
  anchorLeft: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  anchorDow: {
    fontFamily: fontFamily.display,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  anchorMonth: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },

  // Spiegel-pane
  mirrorWrap: {
    paddingHorizontal: 22,
    paddingTop: 4,
    gap: 14,
  },
  mirrorBlock: { gap: 6, paddingTop: 8 },
  mirrorBlockTitle: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    letterSpacing: -0.36,
    paddingBottom: 2,
  },
  mirrorRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: 2,
  },
  mirrorRowLabel: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.14,
  },
  mirrorChipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  mirrorChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
  },
  mirrorChipLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.1,
  },
});
