import { Ionicons } from '@expo/vector-icons';
import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ProfileAvatar } from '@/components/ProfileAvatar';
import { SpinningCross } from '@/components/SpinningCross';
import type {
  ApiEvent,
  ApiLineupEntry,
  ApiOccurrence,
  SaveSource,
} from '@/lib/api';
import { useSession } from '@/lib/authClient';
import {
  dowMixed,
  eventImageUrl,
  eventStillUrl,
  formatDateRange,
  formatPrice,
  formatTimeRange,
  ticketSourceLabel,
  rowTimeLabel,
  isAllDayRange,
  isMultiDay,
  monthShort,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import {
  useEvent,
  useInvitations,
  useMe,
  useMySaves,
  useRespondInvitation,
  useToggleSave,
} from '@/lib/queries';
import type { ApiInvitation, InvitationStatus } from '@/lib/api';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 420;

const VALID_SAVE_SOURCES: readonly SaveSource[] = [
  'venue',
  'friend',
  'search',
  'op-gevoel',
  'avond',
  'agenda',
  'kaart',
  'series',
  'gered',
  'other',
];
function isValidSaveSource(raw: unknown): raw is SaveSource {
  return (
    typeof raw === 'string' &&
    (VALID_SAVE_SOURCES as readonly string[]).includes(raw)
  );
}

/**
 * Event detail screen — fetches via GET /events/:id. Until lineup,
 * photo strip and friends bestaan in de DB blijven die secties leeg.
 */
export default function EventDetail() {
  const {
    id: rawId,
    o: rawOcc,
    source: rawSource,
  } = useLocalSearchParams<{ id: string; o?: string; source?: string }>();
  const id = rawId ?? '';
  // ?o=<occurrenceId> — Agenda/Avond geven aan welk specifiek moment de
  // gebruiker getapt heeft, zodat we de meta-rij + invite-CTA op die
  // avond focussen ipv automatisch op de eerstvolgende.
  const targetOccurrenceId = typeof rawOcc === 'string' ? rawOcc : null;
  // ?source=<screen> — welk scherm leverde deze view op? Voedt de
  // discovery-trail in de persoonlijke spiegel via /saves POST.
  // Callers (avond/agenda/kaart/social/venue/friend/series/search)
  // moeten 'm meegeven; ontbreken = null → backend laat 'm leeg.
  const navSource = isValidSaveSource(rawSource) ? rawSource : null;
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useScrollViewOffset(scrollRef);
  const stickyStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      scrollY.value,
      [HERO_HEIGHT - 140, HERO_HEIGHT - 60],
      [0, 1],
      Extrapolation.CLAMP
    ),
  }));
  const heroStyle = useAnimatedStyle(() => {
    const offset = Math.min(0, scrollY.value);
    const scale = 1 - offset / HERO_HEIGHT;
    return {
      transform: [
        { translateY: ((scale - 1) * HERO_HEIGHT) / 2 },
        { scale },
      ],
    };
  });

  const { data: event, isLoading, error } = useEvent(id);
  const { data: invitations } = useInvitations();

  const selectedOccurrenceId =
    targetOccurrenceId &&
    event?.occurrences?.find((o) => o.id === targetOccurrenceId)
      ? targetOccurrenceId
      : event?.occurrences?.[0]?.id ?? null;

  // Vind een openstaande invitation waar ik nog op moet reageren voor
  // dít event én déze occurrence. Een event kan meerdere occurrences
  // hebben en de invitation is altijd voor één specifieke voorstelling —
  // dus matchen alleen op event.id is niet genoeg (zou banner laten
  // verschijnen op andere data dan waarvoor je uitgenodigd was).
  const pendingInvite =
    invitations?.find(
      (inv) =>
        !inv.isOutgoing &&
        inv.myStatus === 'pending' &&
        inv.event.id === id &&
        inv.occurrence.id === selectedOccurrenceId
    ) ?? null;
  // Pulse-animatie op de Datum-cell is uitgeschakeld — Reanimated
  // worklets met transform: scale waren de waarschijnlijke trigger
  // van een setViewToSnapshot-crash in react-native-screens 4.x bij
  // tab-unmount op iOS 26. De scroll-to-top + selectie-haptic geven
  // genoeg feedback dat de pagina is geupdatet.

  if (isLoading || (!event && !error)) {
    return <DetailFallback>{undefined}</DetailFallback>;
  }
  if (error || !event) {
    return (
      <DetailFallback tone="error">Dit event is niet beschikbaar.</DetailFallback>
    );
  }

  const hasActuele = (event.occurrences?.length ?? 0) > 0;
  const eventOver = !hasActuele;
  const targetMissed =
    targetOccurrenceId !== null &&
    hasActuele &&
    !event.occurrences!.some((o) => o.id === targetOccurrenceId);
  const selectedOccurrence = selectedOccurrenceId
    ? event.occurrences?.find((o) => o.id === selectedOccurrenceId) ?? null
    : null;

  const view = toViewModel(event, selectedOccurrence, locale);
  const stickyTitle = view.title;

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {/* Pinned photo + gradient — stays fixed while content scrolls over it,
          stretches downward when the user pulls past the top. */}
      <Animated.View
        style={[
          styles.heroPinned,
          { backgroundColor: isNacht ? palette.noir : palette.forest },
          heroStyle,
        ]}
      >
        {view.photo && (
          <Image
            source={{ uri: view.photo }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
          />
        )}
        <LinearGradient
          colors={
            isNacht
              ? ['rgba(10,10,11,0.4)', 'rgba(10,10,11,0.2)', 'rgba(10,10,11,0.95)']
              : ['rgba(45,74,62,0.4)', 'rgba(45,74,62,0.3)', 'rgba(45,74,62,0.85)']
          }
          locations={[0, 0.4, 1]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        // Extra scroll-ruimte onderaan zodat de InviteBanner zich
        // boven het keyboard kan positioneren wanneer 'ie zelf
        // scroll-on-focus triggert.
        contentContainerStyle={{
          // Extra ruimte alleen wanneer er een invite-banner is — die
          // moet boven het keyboard kunnen scrollen. Zonder banner geen
          // overbodige leegte onderaan.
          paddingBottom: insets.bottom + 32 + (pendingInvite ? 360 : 0),
        }}
      >
        {/* Transparent hero spacer with the tag + title at the bottom.
            Scrolls with content; the body covers it on scroll-up. */}
        <View style={styles.heroSpacer}>
          <View style={styles.heroBottom}>
            <View
              style={[
                styles.tag,
                { backgroundColor: isNacht ? palette.acid : palette.paper3 },
              ]}
            >
              <Text
                style={[
                  styles.tagText,
                  { color: isNacht ? palette.noir : palette.soil },
                ]}
              >
                {view.tag}
              </Text>
            </View>
            <Text style={styles.heroTitle}>{view.title}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          {((event.genres && event.genres.length > 0) ||
            (event.series && event.series.length > 0)) && (
            <>
              <View style={styles.genreRow}>
                {/* Series-pills eerst — context ("dit hoort bij ADE")
                    weegt zwaarder dan genre. Border ipv solid bg om
                    duidelijk te maken dat ze klikbaar zijn. */}
                {event.series?.map((s) => (
                  <Pressable
                    key={s.id}
                    onPress={() => router.push(`/series/${s.slug}` as never)}
                    style={[
                      styles.seriesPillTop,
                      { borderColor: isNacht ? '#3a3a3e' : palette.paper },
                    ]}
                  >
                    <Ionicons
                      name="layers-outline"
                      size={11}
                      color={roles.fg}
                    />
                    <Text style={[styles.genrePillText, { color: roles.fg }]}>
                      {s.name}
                    </Text>
                  </Pressable>
                ))}
                {event.genres?.map((g) => (
                  <View
                    key={g}
                    style={[styles.genrePill, { backgroundColor: roles.bgTag }]}
                  >
                    <Text style={[styles.genrePillText, { color: roles.fg }]}>
                      {g}
                    </Text>
                  </View>
                ))}
              </View>
              <View style={[styles.divider, { backgroundColor: roles.bgChip }]} />
            </>
          )}

          {(eventOver || targetMissed) && (
            <>
              <View style={styles.expiredNotice}>
                <Ionicons
                  name="time-outline"
                  size={14}
                  color={roles.accent}
                />
                <Text
                  style={[styles.expiredNoticeText, { color: roles.accent }]}
                >
                  {eventOver
                    ? t('Dit event is afgelopen.', 'This event is over.')
                    : t(
                        'De voorstelling die je selecteerde is voorbij. Dit is de eerstvolgende.',
                        'The performance you selected is over. This is the next one.'
                      )}
                </Text>
              </View>
              <View style={[styles.divider, { backgroundColor: roles.bgChip }]} />
            </>
          )}

          <View style={styles.metaRow}>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={
                  isMultiDay(event.startsAt, event.endsAt)
                    ? t('Loopt', 'Runs')
                    : t('Datum', 'Date')
                }
                value={
                  isMultiDay(event.startsAt, event.endsAt) && event.endsAt
                    ? formatDateRange(event.startsAt, event.endsAt, locale)
                    : view.date
                }
              />
            </View>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={
                  view.allDay
                    ? t('Wanneer', 'When')
                    : view.time.includes('–')
                      ? t('Tijd', 'Time')
                      : t('Aanvang', 'Doors')
                }
                value={view.time}
              />
            </View>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={t('Venue', 'Venue')}
                value={view.venue}
                onPress={() => router.push(`/venue/${event.venue.slug}`)}
              />
            </View>
          </View>

          {pendingInvite && (
            <InviteBanner
              invite={pendingInvite}
              scrollRef={scrollRef}
              scrollY={scrollY}
            />
          )}

          {view.description && (
            <Text style={[styles.bodyText, { color: roles.fgRead }]}>
              {view.description}
            </Text>
          )}

          {event.trailerUrl && (
            <TrailerCard
              trailerUrl={event.trailerUrl}
              stillUrl={event.stillUrl ?? event.imageUrl ?? null}
            />
          )}

          {/* === Content-blokken in vaste volgorde:
                lineup → nodig iemand uit → tickets → alle voorstellingen
              === */}

          {selectedOccurrence?.lineup && selectedOccurrence.lineup.length > 0 && (
            <Lineup
              lineup={selectedOccurrence.lineup}
              kicker={
                event.occurrences && event.occurrences.length > 1
                  ? formatLineupKicker(selectedOccurrence.startsAt, locale)
                  : null
              }
            />
          )}

          <CrewAndInvite
            event={event}
            selectedOccurrence={selectedOccurrence}
            onInvite={() => {
              const path =
                selectedOccurrence && !selectedOccurrence.id.endsWith('::next')
                  ? `/event/${id}/invite?o=${selectedOccurrence.id}`
                  : `/event/${id}/invite`;
              router.push(path as never);
            }}
          />

          {selectedOccurrence && (
            <TicketsBlock
              price={view.price}
              priceNote={view.priceNote}
              ticketUrl={selectedOccurrence.ticketUrl ?? event.ticketUrl}
              isNacht={isNacht}
              soldOut={selectedOccurrence.status === 'sold_out'}
            />
          )}

          {event.occurrences && event.occurrences.length > 1 && (
            <OccurrenceList
              occurrences={event.occurrences}
              selectedId={selectedOccurrence?.id ?? null}
              onSelect={(occId) => {
                Haptics.selectionAsync();
                router.setParams({ o: occId });
                // Scroll naar boven zodat de gebruiker de pulse-
                // animatie op de Datum-cell ziet en visueel begrijpt
                // dat de pagina is geupdatet — de tap zat onderaan,
                // de wijziging zit bovenaan.
                scrollRef.current?.scrollTo({ y: 0, animated: true });
              }}
            />
          )}

        </View>
      </Animated.ScrollView>

      {/* Top bar: back + title + actions, all on the same row.
          The blur background and title fade in once the hero title
          scrolls out; the circle buttons stay visible throughout. */}
      <View
        style={[
          styles.topBar,
          { height: insets.top + 50, paddingTop: insets.top + 2 },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, stickyStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <LinearGradient
                colors={['#000', '#000', 'transparent']}
                locations={[0, 0.8, 1]}
                style={StyleSheet.absoluteFill}
              />
            }
          >
            <BlurView
              intensity={40}
              tint={isNacht ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          </MaskedView>
        </Animated.View>

        <View style={styles.topBarRow}>
          <CircleButton icon="chevron-back" onPress={() => safeBack()} />
          <Animated.View style={[styles.topBarTitleWrap, stickyStyle]}>
            <Text
              numberOfLines={1}
              style={[styles.stickyTitle, { color: roles.fg }]}
            >
              {stickyTitle}
            </Text>
          </Animated.View>
          <View style={styles.heroActions}>
            <HeartButton
              occurrenceId={selectedOccurrenceId}
              saveSource={navSource}
            />
            <ShareButton event={event} />
          </View>
        </View>
      </View>

    </View>
  );
}

type CrewRow = {
  user: { id: string; name: string; handle: string | null; avatarUrl: string | null };
  /** Heeft deze persoon dit event in z'n gered (organisch of via going). */
  saved: boolean;
  /** Response-status van een door mij verzonden invite, als die er is.
      'pending'|'going'|'maybe'|'not_going'. */
  inviteStatus?: InvitationStatus;
  /** Als ik deze persoon heb uitgenodigd: invitationId + of er al een
      reminder is verstuurd. Voor de reminder-knop. */
  myInvitationId?: string;
  reminderSentAt?: string | null;
  /** Voor groepsleden zonder directe vriendschap met mij: naam van de
      groep waarlangs ik visibility heb ("Vrijdagclub"). */
  viaGroupName?: string | null;
  /** Klikt-op-rij navigeert naar /invitation/[id] in plaats van /friend
      — voor mijn eigen-rij zodat je je eigen invite-context kan inzien. */
  linkInvitationId?: string;
  /** True voor de "Jij"-rij; CrewRowItem rendert (jij)-suffix. */
  isMe?: boolean;
};

/**
 * Eén visueel blok dat de "wie gaat erheen"-lijst en de invite-CTA
 * combineert. Bij geen crew: alleen invite-CTA met volle borderRadius.
 * Bij wel crew: gedeelde container, crew bovenin met rounded top,
 * invite-CTA onderin met rounded bottom, hairline-scheiding ertussen,
 * dezelfde border-kleur over de hele rand.
 */
/**
 * Banner op de event-detail wanneer er een openstaande invitation is
 * voor dít event én déze occurrence. Drie knoppen sinds slice B: Ga
 * mee / Misschien / Nee. Reply-veld blijft optioneel. Na actie verdwijnt
 * de banner (de respond-mutation updatet useInvitations, waardoor de
 * match wegvalt).
 */
function InviteBanner({
  invite,
  scrollRef,
  scrollY,
}: {
  invite: ApiInvitation;
  scrollRef: ReturnType<typeof useAnimatedRef<Animated.ScrollView>>;
  scrollY: ReturnType<typeof useScrollViewOffset>;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const respond = useRespondInvitation();
  const busy = respond.isPending;
  const [reply, setReply] = useState('');
  const bannerRef = useRef<View>(null);
  const { height: windowHeight } = useWindowDimensions();

  // Wanneer het keyboard opent (door tap op het reply-veld), scroll
  // de banner zo dat z'n onderkant — én dus de respons-knoppen — boven
  // het keyboard staat. Geen `automaticallyAdjustKeyboardInsets`
  // gebruiken: die scrollt alleen genoeg voor het input-veld, niet
  // voor de knoppen eronder.
  useEffect(() => {
    const showEvent =
      Platform.OS === 'ios' ? 'keyboardDidShow' : 'keyboardDidShow';
    const sub = Keyboard.addListener(showEvent, (e) => {
      const kbHeight = e.endCoordinates?.height ?? 0;
      if (kbHeight <= 0) return;
      bannerRef.current?.measureInWindow((_x, y, _w, height) => {
        const bannerBottom = y + height;
        const desiredBottom = windowHeight - kbHeight - 20;
        const overflow = bannerBottom - desiredBottom;
        if (overflow > 0 && scrollRef.current) {
          scrollRef.current.scrollTo({
            y: scrollY.value + overflow,
            animated: true,
          });
        }
      });
    });
    return () => sub.remove();
  }, [windowHeight, scrollRef, scrollY]);
  const fromName =
    invite.from.name?.trim() ||
    (invite.from.handle ? `@${invite.from.handle}` : t('Iemand', 'Someone'));

  const onRespond = (status: 'going' | 'maybe' | 'not_going') => {
    if (busy) return;
    // Haptic bij tap: notification voor going (success-feel),
    // impactAsync(Medium) voor maybe/nee — voelbaarder dan
    // selectionAsync (die op iOS soms helemaal niet voelt).
    if (status === 'going') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    respond.mutate({
      id: invite.id,
      status,
      replyMessage: reply.trim() || undefined,
      eventId: invite.event.id,
    });
  };

  return (
    <View
      ref={bannerRef}
      style={[
        styles.inviteBanner,
        {
          backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          borderColor: isNacht ? '#2a2a2d' : palette.paper,
        },
      ]}
    >
      <View style={styles.inviteHead}>
        <ProfileAvatar
          avatarUrl={invite.from.avatarUrl ?? null}
          name={fromName}
          size={36}
        />
        <View style={styles.inviteHeadText}>
          <Text style={[styles.inviteKicker, { color: roles.fgMuted }]}>
            {invite.group
              ? t(
                  `VIA ${invite.group.name.toUpperCase()}`,
                  `VIA ${invite.group.name.toUpperCase()}`
                )
              : t('UITGENODIGD DOOR', 'INVITED BY')}
          </Text>
          <Text style={[styles.inviteName, { color: roles.fg }]}>
            {fromName}
          </Text>
        </View>
      </View>
      {invite.message && invite.message.length > 0 && (
        <Text style={[styles.inviteMessage, { color: roles.fgRead }]}>
          “{invite.message}”
        </Text>
      )}
      <View
        style={[
          styles.inviteReplyField,
          {
            backgroundColor: isNacht ? palette.noir : palette.paper3,
            borderColor: isNacht ? '#2a2a2d' : palette.paper,
          },
        ]}
      >
        <TextInput
          value={reply}
          onChangeText={setReply}
          placeholder={t(
            'kort antwoord (optioneel)',
            'short reply (optional)'
          )}
          placeholderTextColor={roles.fgPlaceholder}
          multiline
          maxLength={280}
          editable={!busy}
          style={[styles.inviteReplyInput, { color: roles.fg }]}
        />
      </View>
      <View style={styles.inviteActions}>
        <TouchableOpacity
          onPress={() => onRespond('going')}
          disabled={busy}
          activeOpacity={0.65}
          style={[
            styles.inviteBtn,
            {
              backgroundColor: roles.accent,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text style={[styles.inviteBtnText, { color: roles.onAccent }]}>
            {t('Ga', 'Going')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onRespond('maybe')}
          disabled={busy}
          activeOpacity={0.65}
          style={[
            styles.inviteBtn,
            {
              backgroundColor: isNacht ? palette.noir3 : palette.paper,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text style={[styles.inviteBtnText, { color: roles.fg }]}>
            {t('Misschien', 'Maybe')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onRespond('not_going')}
          disabled={busy}
          activeOpacity={0.65}
          style={[
            styles.inviteBtn,
            {
              backgroundColor: isNacht ? palette.noir3 : palette.paper,
              opacity: busy ? 0.5 : 1,
            },
          ]}
        >
          <Text style={[styles.inviteBtnText, { color: roles.fgMuted }]}>
            {t('Nee', 'No')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function CrewAndInvite({
  event,
  selectedOccurrence,
  onInvite,
}: {
  event: ApiEvent;
  selectedOccurrence: ApiOccurrence | null;
  onInvite: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const t = useT();
  const { data: me } = useMe();
  const { data: invitations } = useInvitations();

  const rows = useMemo<CrewRow[]>(() => {
    // Crew is occurrence-specific: alleen vrienden die díe voorstelling
    // gesaved hebben + invites die voor díe occurrence zijn verzonden.
    // Een vriend die alleen de 19:30 saved staat dus niet bij de 22:00.
    const occFriends =
      selectedOccurrence?.friendsSaved ?? event.friendsSaved ?? [];
    const myOccInvites = selectedOccurrence
      ? (event.myInvites ?? []).filter(
          (inv) => inv.occurrenceId === selectedOccurrence.id
        )
      : (event.myInvites ?? []);
    const incomingAccepted = selectedOccurrence
      ? (event.incomingAcceptedInvites ?? []).filter(
          (inv) => inv.occurrenceId === selectedOccurrence.id
        )
      : (event.incomingAcceptedInvites ?? []);
    const occPeopleGoing = selectedOccurrence
      ? (event.peopleGoing ?? []).filter(
          (p) => p.occurrenceId === selectedOccurrence.id
        )
      : (event.peopleGoing ?? []);
    const map = new Map<string, CrewRow>();
    for (const f of occFriends) {
      map.set(f.id, { user: f, saved: true });
    }
    // Mijn-uitgaande invitations: voegt status + invitationId toe voor
    // de reminder-knop. Voor groep-invites zit `viaGroupName` op de
    // invite-row — die laten we in de crew zien zodat ik weet via welke
    // groep ik iemand heb uitgenodigd.
    for (const inv of myOccInvites) {
      const existing = map.get(inv.to.id);
      if (existing) {
        existing.inviteStatus = inv.status;
        existing.myInvitationId = inv.id;
        existing.reminderSentAt = inv.reminderSentAt;
        if (!existing.viaGroupName && inv.viaGroupName) {
          existing.viaGroupName = inv.viaGroupName;
        }
      } else {
        map.set(inv.to.id, {
          user: inv.to,
          saved: false,
          inviteStatus: inv.status,
          myInvitationId: inv.id,
          reminderSentAt: inv.reminderSentAt,
          viaGroupName: inv.viaGroupName,
        });
      }
    }
    // Vrienden wiens uitnodiging ik heb geaccepteerd ('going'): zelfde
    // "Gaat mee"-status — connection-flag i.p.v. hearted-only.
    for (const inv of incomingAccepted) {
      const existing = map.get(inv.from.id);
      if (existing) existing.inviteStatus = 'going';
      else
        map.set(inv.from.id, {
          user: inv.from,
          saved: true,
          inviteStatus: 'going',
        });
    }
    // Iedereen anders met een going-respons op een invitation waar ik in
    // zit (groepsleden + 1-op-1 recipients). Voor groepsleden die geen
    // friend van mij zijn is dit de enige weg om ze in crew te krijgen.
    for (const p of occPeopleGoing) {
      const existing = map.get(p.user.id);
      if (existing) {
        existing.inviteStatus = 'going';
        if (!existing.viaGroupName && p.viaGroupName) {
          existing.viaGroupName = p.viaGroupName;
        }
      } else {
        map.set(p.user.id, {
          user: p.user,
          saved: false,
          inviteStatus: 'going',
          viaGroupName: p.viaGroupName,
        });
      }
    }
    // Mezelf-rij: wanneer ik 'going' ben op een invitation voor deze
    // occurrence, verschijn ik óók in de crew met de eigen avatar en een
    // (jij)-suffix. Tap op de rij gaat naar /invitation/[id] zodat je
    // alle responses kunt bekijken. Pakt de eerste matching invitation
    // — meerdere zijn zelden tegelijk relevant.
    if (me?.id && selectedOccurrence && invitations) {
      const myGoing = invitations.find(
        (inv) =>
          !inv.revokedAt &&
          inv.occurrence.id === selectedOccurrence.id &&
          inv.myStatus === 'going'
      );
      if (myGoing) {
        map.set(me.id, {
          user: {
            id: me.id,
            name: me.name || '',
            handle: me.handle ?? null,
            avatarUrl: me.avatarUrl ?? null,
          },
          saved: true,
          inviteStatus: 'going',
          linkInvitationId: myGoing.id,
          isMe: true,
          viaGroupName: myGoing.group?.name ?? null,
        });
      }
    }
    // Sort: going > saved-only > maybe > pending > not_going. Alfabetisch
    // binnen elke groep.
    const order = (r: CrewRow): number => {
      if (r.inviteStatus === 'going') return 0;
      if (!r.inviteStatus && r.saved) return 1;
      if (r.inviteStatus === 'maybe') return 2;
      if (r.inviteStatus === 'pending') return 3;
      return 4;
    };
    return Array.from(map.values()).sort(
      (a, b) => order(a) - order(b) || a.user.name.localeCompare(b.user.name)
    );
  }, [
    selectedOccurrence,
    event.friendsSaved,
    event.myInvites,
    event.incomingAcceptedInvites,
    event.peopleGoing,
    me,
    invitations,
  ]);

  const hasCrew = rows.length > 0;
  const borderColor = isNacht ? '#232327' : palette.paper;
  const innerBorderColor = isNacht ? '#1d1d20' : palette.paper;
  const surface = isNacht ? '#101012' : palette.paper2;

  return (
    <>
      <Text style={[styles.crewHeading, { color: roles.fg }]}>
        {t('Vrienden', 'Friends')}
      </Text>
      <View
        style={[
          styles.crewInviteContainer,
          {
            borderColor,
            marginTop: 6,
          },
        ]}
      >
        {hasCrew && (
          <View>
            {rows.map((row, i) => (
              <CrewRowItem
                key={row.user.id}
                row={row}
                first={i === 0}
                eventId={event.id}
              />
            ))}
          </View>
        )}
        <Pressable
          onPress={onInvite}
          style={[
            styles.crewInviteCta,
            { backgroundColor: surface },
            hasCrew && {
              borderTopColor: innerBorderColor,
              borderTopWidth: StyleSheet.hairlineWidth,
            },
          ]}
        >
          <Ionicons name="person-add-outline" size={18} color={roles.fg} />
          <Text style={[styles.inviteText, { color: roles.fg }]}>
            {t('Nodig iemand uit', 'Invite someone')}
          </Text>
          <Text style={[styles.inviteChev, { color: roles.fgPlaceholder }]}>
            ›
          </Text>
        </Pressable>
      </View>
    </>
  );
}

function CrewRowItem({
  row,
  first,
  eventId,
}: {
  row: CrewRow;
  first: boolean;
  eventId: string;
}) {
  const mode = useMode();
  const roles = useRoles();
  const t = useT();
  const isNacht = mode === 'nacht';
  const subtle = !row.saved && row.inviteStatus === 'not_going';
  const onRowPress = () => {
    // Eigen rij heeft een directe link naar /invitation/[id]; anderen
    // gaan naar friend-detail.
    if (row.linkInvitationId) {
      router.push(`/invitation/${row.linkInvitationId}` as never);
    } else {
      router.push(`/friend/${row.user.id}` as never);
    }
  };
  return (
    <Pressable
      onPress={onRowPress}
      style={[
        styles.crewRow,
        !first && {
          borderTopColor: isNacht ? '#1d1d20' : palette.paper,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        subtle && { opacity: 0.6 },
      ]}
    >
      {row.user.avatarUrl ? (
        <Image
          source={{ uri: row.user.avatarUrl }}
          style={styles.crewAv}
          contentFit="cover"
        />
      ) : (
        <View
          style={[
            styles.crewAv,
            styles.crewAvFallback,
            { backgroundColor: isNacht ? palette.noir3 : palette.paper },
          ]}
        >
          <Text style={[styles.crewAvInitial, { color: roles.fgMuted }]}>
            {(row.user.name.trim()[0] ?? '?').toUpperCase()}
          </Text>
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={[styles.crewName, { color: roles.fg }]}
        >
          {row.user.name}
          {row.isMe ? t(' (jij)', ' (you)') : ''}
        </Text>
        {row.viaGroupName ? (
          <Text
            numberOfLines={1}
            style={[styles.crewVia, { color: roles.fgMuted }]}
          >
            {`via ${row.viaGroupName}`}
          </Text>
        ) : null}
      </View>
      <CrewStatusBadge row={row} eventId={eventId} />
    </Pressable>
  );
}

function CrewStatusBadge({ row }: { row: CrewRow; eventId: string }) {
  const roles = useRoles();
  const t = useT();
  // Status-only pil. De Herinner-actie zit op /invitation/[id] — daar
  // heb je per-recipient context én één-shot reminderSentAt-state.
  // Op event-detail tonen we alleen wat iemands status is, geen actie.
  if (row.saved && !row.inviteStatus) return null;
  if (!row.inviteStatus) return null;
  const label =
    row.inviteStatus === 'going'
      ? t('Gaat', 'Going')
      : row.inviteStatus === 'maybe'
        ? t('Misschien', 'Maybe')
        : row.inviteStatus === 'not_going'
          ? t('Afgezegd', 'Not coming')
          : t('Wacht op antwoord', 'Awaiting reply');
  const textTone =
    row.inviteStatus === 'going'
      ? roles.accent
      : row.inviteStatus === 'not_going'
        ? roles.fgPlaceholder
        : roles.fgMuted;
  return (
    <View style={[styles.crewPill, { borderColor: `${textTone}80` }]}>
      <Text style={[styles.crewPillText, { color: textTone }]}>{label}</Text>
    </View>
  );
}

function formatLineupKicker(startsAt: string, locale: Locale): string {
  const d = new Date(startsAt);
  return `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(d.getMonth(), locale).toLowerCase()}`;
}

const ROLE_LABEL: Record<NonNullable<ApiLineupEntry['role']>, string> = {
  headliner: 'Headliner',
  support: 'Support',
  act: 'Act',
  dj: 'DJ',
};

/**
 * Lineup-block voor concerten, voorstellingen, openingen — toont wie er
 * speelt/optreedt voor de eerstvolgende occurrence. Volgorde komt uit
 * de DB (curator beslist). Voor wekelijkse feesten met wisselende
 * lineups: kicker geeft aan welke avond deze lineup hoort.
 */
function Lineup({
  lineup,
  kicker,
}: {
  lineup: ApiLineupEntry[];
  kicker: string | null;
}) {
  const roles = useRoles();
  const t = useT();
  return (
    <>
      <View style={styles.lineupHeading}>
        <Text
          style={[
            styles.crewHeading,
            // marginTop staat op de wrapper-View, neutraliseren we hier
            // zodat we niet dubbele spacing krijgen.
            { color: roles.fg, marginTop: 0, marginBottom: 0 },
          ]}
        >
          {t('Lineup', 'Lineup')}
        </Text>
        {kicker && (
          <Text style={[styles.lineupKicker, { color: roles.fgMuted }]}>
            {kicker}
          </Text>
        )}
      </View>
      <View style={[styles.lineupBlock, { borderColor: roles.bgChip }]}>
        {lineup.map((entry, i) => {
          const inner = (
            <>
              <Text
                numberOfLines={1}
                style={[
                  styles.lineupName,
                  {
                    color: roles.fg,
                    fontFamily:
                      entry.role === 'headliner'
                        ? fontFamily.display
                        : fontFamily.medium,
                    fontSize: entry.role === 'headliner' ? 17 : 14.5,
                    letterSpacing: entry.role === 'headliner' ? -0.34 : -0.14,
                  },
                ]}
              >
                {entry.name}
              </Text>
              {entry.artistId && (
                <Ionicons
                  name="chevron-forward"
                  size={14}
                  color={roles.fgMuted}
                  style={{ marginLeft: 4 }}
                />
              )}
              {entry.role && (
                <Text style={[styles.lineupRole, { color: roles.fgMuted }]}>
                  {ROLE_LABEL[entry.role]}
                </Text>
              )}
            </>
          );
          const rowStyle = [
            styles.lineupRow,
            i > 0 && { borderTopColor: roles.bgChip, borderTopWidth: StyleSheet.hairlineWidth },
          ];
          // Klikbaar alleen als we een artist-record hebben — eerlijk
          // signaal dat er een echte pagina achter zit. Anders gewoon
          // tekst (geen valse beloftes).
          if (entry.artistId) {
            return (
              <Pressable
                key={`${entry.name}-${i}`}
                onPress={() => router.push(`/artist/${entry.artistId}` as never)}
                style={rowStyle}
              >
                {inner}
              </Pressable>
            );
          }
          return (
            <View key={`${entry.name}-${i}`} style={rowStyle}>
              {inner}
            </View>
          );
        })}
      </View>
    </>
  );
}

/**
 * Lijst van alle aankomende voorstellingen/momenten — getoond als een
 * event meer dan 1 occurrence heeft (films, wekelijkse feesten,
 * theater-residencies). Per occurrence ook de top-lineup-naam zodat
 * je in één oogopslag ziet welke avond bij welke act hoort.
 */
/**
 * Tickets-blok inline in de content. Prijs links (groot, display-font),
 * Tickets-button rechts. Geen sticky dock meer — de gebruiker scrollt
 * gewoon naar dit blok om te kopen, naast lineup en crew.
 */
function TicketsBlock({
  price,
  priceNote,
  ticketUrl,
  isNacht,
  soldOut,
}: {
  price: string;
  priceNote: string | null;
  ticketUrl: string | null;
  isNacht: boolean;
  soldOut: boolean;
}) {
  const roles = useRoles();
  const t = useT();
  const source = ticketSourceLabel(ticketUrl);
  // priceNote (rijkere venue-tekst) krijgt voorrang boven het kale
  // ticket-domein als subtitle.
  const subtitle = priceNote ?? (source ? `via ${source}` : null);
  const title = soldOut
    ? t('Uitverkocht', 'Sold out')
    : price
      ? `${t('Tickets', 'Tickets')} ${price}`
      : t('Tickets', 'Tickets');

  // Disabled state — geen tap, grijze border, geen acid-fill.
  if (soldOut || !ticketUrl) {
    return (
      <View
        style={[
          styles.ticketsBigCtaDisabled,
          { borderColor: isNacht ? '#232327' : palette.paper },
        ]}
      >
        <Text style={[styles.ticketsBigCtaTitle, { color: roles.fgMuted }]}>
          {title}
        </Text>
        {subtitle && (
          <Text
            style={[styles.ticketsBigCtaSubtitle, { color: roles.fgMuted }]}
          >
            {subtitle}
          </Text>
        )}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        // SFSafariViewController (iOS) / Chrome Custom Tabs (Android) —
        // deelt cookies/autofill met system browser én ondersteunt
        // Apple Pay + iDEAL-deeplinks naar bank-apps. Gebruiker swipet
        // 'Done' om terug te keren naar Andreas met state intact.
        WebBrowser.openBrowserAsync(ticketUrl).catch(() => {
          // Fallback: extern openen als de in-app browser faalt.
          Linking.openURL(ticketUrl).catch(() => {});
        });
      }}
      style={[
        styles.ticketsBigCta,
        { backgroundColor: isNacht ? palette.acid : palette.soil },
      ]}
    >
      <View style={styles.ticketsBigCtaContent}>
        <Text
          style={[
            styles.ticketsBigCtaTitle,
            { color: isNacht ? palette.noir : palette.paper3 },
          ]}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            style={[
              styles.ticketsBigCtaSubtitle,
              {
                color: isNacht
                  ? 'rgba(10,10,11,0.65)'
                  : 'rgba(255,255,255,0.7)',
              },
            ]}
          >
            {subtitle}
          </Text>
        )}
      </View>
      <Text
        style={[
          styles.ticketsBigCtaArrow,
          { color: isNacht ? palette.noir : palette.paper3 },
        ]}
      >
        ›
      </Text>
    </Pressable>
  );
}

function OccurrenceList({
  occurrences,
  selectedId,
  onSelect,
}: {
  occurrences: ApiOccurrence[];
  selectedId: string | null;
  onSelect: (occurrenceId: string) => void;
}) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();
  // Groepeer op venue-naam. Alleen relevant voor films met meerdere
  // bioscopen — bij single-venue events krijg je één groep en functioneert
  // 't als de oude "Alle voorstellingen"-lijst, met de venue-naam als
  // kop i.p.v. een generiek label.
  const groupedByVenue = (() => {
    const map = new Map<string, ApiOccurrence[]>();
    for (const o of occurrences) {
      const key = o.venue?.name ?? t('Alle voorstellingen', 'All performances');
      const arr = map.get(key);
      if (arr) arr.push(o);
      else map.set(key, [o]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([venueName, list]) => ({
        venueName,
        list: list.sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
        ),
      }));
  })();
  return (
    <>
      {groupedByVenue.map(({ venueName, list }) => (
        <View key={venueName}>
          <Text style={[styles.crewHeading, { color: roles.fg }]}>
            {venueName} ({list.length})
          </Text>
          <View style={[styles.occList, { borderColor: roles.bgChip }]}>
            {list.map((o) => {
          const d = new Date(o.startsAt);
          const dow = dowMixed(d.getDay(), locale);
          const day = d.getDate();
          const month = monthShort(d.getMonth(), locale).toLowerCase();
          const year = d.getFullYear();
          const time = rowTimeLabel(o.startsAt, o.endsAt, locale);
          const lineupHint =
            o.lineup && o.lineup.length > 0
              ? o.lineup.length === 1
                ? o.lineup[0].name
                : `${o.lineup[0].name} +${o.lineup.length - 1}`
              : null;
          const isSelected = o.id === selectedId;
          return (
            <Pressable
              key={o.id}
              onPress={() => onSelect(o.id)}
              style={[
                styles.occRow,
                { borderTopColor: roles.bgChip },
                isSelected && {
                  backgroundColor: roles.bgTag,
                  borderLeftColor: roles.accent,
                  borderLeftWidth: 3,
                },
              ]}
            >
              <View style={styles.occHeader}>
                <Text
                  style={[
                    styles.occDate,
                    { color: isSelected ? roles.accent : roles.fg },
                  ]}
                >
                  {dow} {day} {month} {year}
                </Text>
                <Text style={[styles.occTime, { color: roles.fgMuted }]}>
                  {time}
                  {o.room ? ` · ${o.room}` : ''}
                </Text>
                <Text style={[styles.occPrice, { color: roles.fgMuted }]}>
                  {o.status === 'sold_out'
                    ? t('Uitverkocht', 'Sold out')
                    : o.status === 'cancelled'
                      ? t('Geannuleerd', 'Cancelled')
                      : formatPrice(o.priceCents, locale)}
                </Text>
              </View>
              {lineupHint && (
                <Text
                  numberOfLines={1}
                  style={[styles.occLineup, { color: roles.fgRead }]}
                >
                  {lineupHint}
                </Text>
              )}
            </Pressable>
          );
            })}
          </View>
        </View>
      ))}
    </>
  );
}

function CircleButton({
  icon,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.circleBtn}>
      <Ionicons name={icon} size={20} color={palette.ink} />
    </Pressable>
  );
}

type ViewModel = {
  tag: string;
  title: string;
  date: string;
  time: string;
  allDay: boolean;
  venue: string;
  description: string | null;
  photo: string | null;
  price: string;
  priceNote: string | null;
};

function toViewModel(
  event: ApiEvent,
  occ: ApiOccurrence | null,
  locale: Locale
): ViewModel {
  // Voor exhibitions zonder selected occurrence valt 'ie terug op
  // event.startsAt (gedenormaliseerd vanuit nextOccurrence). Voor shows
  // verwachten we altijd een occurrence — past door een query mismatch.
  const sourceStart = occ?.startsAt ?? event.startsAt;
  const sourceEnd = occ?.endsAt ?? event.endsAt;
  const sourcePriceCents = occ?.priceCents ?? event.priceCents;
  const sourcePriceNote = occ?.priceNote ?? event.priceNote;
  const d = new Date(sourceStart);
  const dow = dowMixed(d.getDay(), locale);
  const day = d.getDate();
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const year = d.getFullYear();
  const priceNote =
    (sourcePriceNote && sourcePriceNote.trim().length > 0
      ? sourcePriceNote.trim()
      : null) ??
    (event.venue.priceNote && event.venue.priceNote.trim().length > 0
      ? event.venue.priceNote.trim()
      : null);
  return {
    tag: translateCategory(event.category, locale),
    title: event.title,
    date: `${dow} ${day} ${month} ${year}`,
    time: formatTimeRange(sourceStart, sourceEnd, locale),
    allDay: isAllDayRange(sourceStart, sourceEnd),
    // Voor films die in meerdere bioscopen draaien: toon de venue van
    // de geselecteerde occurrence i.p.v. het event-level venue. Voor
    // single-venue events (concerts/theater) is occ.venue gelijk aan
    // event.venue zodat dit niets verandert.
    venue: occ?.venue?.name ?? event.venue.name,
    description: event.description,
    // Voor de hero willen we het sfeerbeeld (still/backdrop) — geeft
    // meer atmosfeer dan een poster. eventStillUrl prefereert
    // stillUrl, valt terug op imageUrl, dan venue-image.
    photo: eventStillUrl(event),
    price: formatPrice(sourcePriceCents, locale),
    priceNote,
  };
}

/** Inline trailer-card onder de description. Links: stillUrl-thumb met
    play-icon overlay; rechts: "Bekijk de trailer"-label + "YouTube"-
    subline. Tap opent expo-web-browser's in-app browser sheet (iOS
    SafariViewController, Android Chrome Custom Tabs) — YouTube speelt
    daarin embedded zonder dat we de gebruiker uit de app jagen. */
function TrailerCard({
  trailerUrl,
  stillUrl,
}: {
  trailerUrl: string;
  stillUrl: string | null;
}) {
  const roles = useRoles();
  const t = useT();
  return (
    <Pressable
      onPress={() => WebBrowser.openBrowserAsync(trailerUrl)}
      style={[styles.trailerCard, { backgroundColor: roles.bgLift }]}
    >
      <View style={styles.trailerThumbWrap}>
        {stillUrl ? (
          <Image
            source={{ uri: stillUrl }}
            style={styles.trailerThumb}
            contentFit="cover"
          />
        ) : (
          <View
            style={[
              styles.trailerThumb,
              { backgroundColor: roles.bgChip },
            ]}
          />
        )}
        <View style={styles.trailerPlayOverlay}>
          <Ionicons name="play" size={20} color="#fff" />
        </View>
      </View>
      <View style={styles.trailerTextWrap}>
        <Text style={[styles.trailerTitle, { color: roles.fg }]}>
          {t('Bekijk de trailer', 'Watch the trailer')}
        </Text>
        <Text style={[styles.trailerSub, { color: roles.fgMuted }]}>
          YouTube
        </Text>
      </View>
    </Pressable>
  );
}

function ShareButton({ event }: { event: ApiEvent }) {
  const { data: session } = useSession();
  const t = useT();
  const onPress = async () => {
    const refQs = session?.user?.id
      ? `?ref=${encodeURIComponent(session.user.id)}`
      : '';
    const url = `https://andreas.amsterdam/e/${encodeURIComponent(event.id)}${refQs}`;
    const messageBody = t(
      `Ik ga naar ${event.title} via Andreas. Wil je mee?\n${url}`,
      `I’m going to ${event.title} via Andreas. Want to come?\n${url}`
    );
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url, message: messageBody }
          : { message: messageBody }
      );
      Haptics.selectionAsync();
    } catch {
      // Cancel of share-error — geen actie nodig.
    }
  };
  return (
    <Pressable onPress={onPress} style={styles.circleBtn}>
      <Ionicons name="share-outline" size={20} color={palette.ink} />
    </Pressable>
  );
}

function HeartButton({
  occurrenceId,
  saveSource,
}: {
  occurrenceId: string | null;
  saveSource: SaveSource | null;
}) {
  const mode = useMode();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: saves } = useMySaves({ enabled: authed });
  const toggleMutation = useToggleSave();
  const isSaved = Boolean(
    occurrenceId && saves?.some((s) => s.occurrenceId === occurrenceId)
  );
  const scale = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const onPress = () => {
    if (!authed) {
      // Niet ingelogd → naar de Jij-tab waar de inlog-flow leeft.
      router.push('/jij');
      return;
    }
    if (!occurrenceId) return; // Geen actieve occurrence (event afgelopen)
    scale.value = withSequence(
      withTiming(1.3, { duration: 140 }),
      withTiming(1, { duration: 180 })
    );
    if (!isSaved) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } else {
      Haptics.selectionAsync();
    }
    toggleMutation.mutate({ occurrenceId, source: saveSource });
  };

  const iconName = isSaved ? 'heart' : 'heart-outline';
  const iconColor = isSaved
    ? mode === 'nacht'
      ? palette.acid
      : palette.red
    : palette.ink;

  return (
    <Animated.View style={animStyle}>
      <Pressable onPress={onPress} style={styles.circleBtn}>
        <Ionicons name={iconName} size={20} color={iconColor} />
      </Pressable>
    </Animated.View>
  );
}

function DetailFallback({
  children,
  tone = 'muted',
}: {
  children?: string;
  tone?: 'muted' | 'error';
}) {
  const mode = useMode();
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View
        style={[
          styles.topBar,
          { height: insets.top + 50, paddingTop: insets.top + 2 },
        ]}
      >
        <View style={styles.topBarRow}>
          <CircleButton icon="chevron-back" onPress={() => safeBack()} />
        </View>
      </View>
      <View style={styles.fallbackBody}>
        {children ? (
          <Text
            style={[
              styles.fallbackText,
              { color: tone === 'error' ? '#c9453a' : roles.fgMuted },
            ]}
          >
            {children}
          </Text>
        ) : (
          <SpinningCross size={32} color={roles.fgPlaceholder} />
        )}
        {tone === 'error' && (
          <Pressable
            onPress={() => safeBack()}
            style={[
              styles.fallbackAction,
              { borderColor: isNacht ? '#2a2a2e' : palette.paper },
            ]}
          >
            <Text style={[styles.fallbackActionText, { color: roles.fg }]}>
              Terug naar overzicht
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function MetaCell({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const Wrap = onPress ? Pressable : View;
  const borderColor = onPress
    ? roles.accent
    : isNacht
      ? '#232327'
      : palette.paper;
  return (
    <Wrap
      onPress={onPress}
      style={[
        styles.metaCell,
        {
          backgroundColor: isNacht ? '#101012' : palette.paper2,
          borderColor,
        },
      ]}
    >
      <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
    </Wrap>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Hero
  heroPinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HERO_HEIGHT,
    overflow: 'hidden',
  },
  heroSpacer: {
    height: HERO_HEIGHT,
    paddingHorizontal: 18,
    paddingBottom: 20,
    justifyContent: 'flex-end',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  topBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 8,
  },
  topBarTitleWrap: {
    flex: 1,
    alignItems: 'center',
  },
  stickyTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
  },
  heroActions: { flexDirection: 'row', gap: 8 },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBottom: { gap: 12 },
  tag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  tagText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  heroTitle: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    lineHeight: 38 * 0.92,
    letterSpacing: -1.5,
    color: palette.ink,
  },

  // Body
  body: { padding: 20 },

  // Meta row — alignItems stretch zodat de drie cells altijd dezelfde
  // hoogte hebben, ook als één venue-naam over twee regels wrapt.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginBottom: 20,
  },
  // Animated.View wrapper rond MetaCell — flex hier zodat de cells
  // gelijkmatig 1/3 ruimte krijgen, en de pulse-animatie alleen op
  // de wrapper komt (transform op MetaCell zou border laten flikkeren).
  metaCellWrap: { flex: 1 },
  metaCell: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  metaLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 9,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  metaValue: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.21,
    marginTop: 4,
  },

  bodyText: {
    fontFamily: fontFamily.body,
    fontSize: 14.5,
    lineHeight: 20.8,
    marginBottom: 12,
  },

  // Inline trailer-card onder de description. Compacte horizontale
  // tile: still-thumb links (16:9), tekst rechts ("Bekijk de
  // trailer" + "YouTube"-subline). Tap opent een in-app browser sheet.
  trailerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    padding: 8,
    marginBottom: 14,
  },
  trailerThumbWrap: {
    position: 'relative',
    width: 120,
    aspectRatio: 16 / 9,
    borderRadius: 8,
    overflow: 'hidden',
  },
  trailerThumb: {
    width: '100%',
    height: '100%',
  },
  trailerPlayOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  trailerTextWrap: { flex: 1 },
  trailerTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.17,
    marginBottom: 2,
  },
  trailerSub: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Invite-banner — verschijnt tussen meta-rij en description wanneer
  // er een openstaande uitnodiging is voor dit event + occurrence.
  inviteBanner: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 12,
    marginBottom: 14,
  },
  inviteHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  inviteHeadText: { flex: 1, minWidth: 0, gap: 2 },
  inviteKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  inviteName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.23,
  },
  inviteMessage: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  inviteReplyField: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 60,
  },
  inviteReplyInput: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    padding: 0,
    minHeight: 40,
    textAlignVertical: 'top',
  },
  inviteActions: {
    flexDirection: 'row',
    gap: 8,
  },
  inviteBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteBtnText: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.07,
  },

  genreRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 18,
  },
  genrePill: {
    height: 26,
    paddingHorizontal: 11,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Series-pill in de label-strip bovenaan — border ipv solid bg om
  // visueel te tonen dat 'ie tapbaar is (genre-pills zijn dat niet).
  // Icoon + naam in dezelfde mono-stijl als genres voor visuele rust.
  seriesPillTop: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  genrePillText: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },

  // Section-heading — gebruikt boven elk content-blok (Lineup, Tickets,
  // Nodig iemand uit, Alle voorstellingen, Onderdeel van). Royale
  // marginTop zodat het blok ervóór niet tegen de tekst aanloopt.
  // Inhoud-blokken hebben zelf geen marginBottom — alle ruimte komt
  // van deze marginTop, dat houdt het ritme consistent.
  crewHeading: {
    fontFamily: fontFamily.display,
    fontSize: 18,
    lineHeight: 18,
    letterSpacing: -0.36,
    marginTop: 26,
    marginBottom: 6,
  },

  // Occurrence-list — toont alle voorstellingen voor multi-occurrence
  // events (films, residencies, wekelijkse feesten). Zelfde border-stijl
  // als crew-block voor visuele rust.
  occList: {
    marginTop: 6,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  occRow: {
    paddingHorizontal: 14,
    paddingVertical: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  occHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  occDate: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 13.5,
    letterSpacing: -0.13,
  },
  occTime: {
    fontFamily: fontFamily.medium,
    fontSize: 12.5,
    letterSpacing: -0.06,
  },
  occPrice: {
    fontFamily: fontFamily.mono,
    fontSize: 11.5,
    letterSpacing: 0.4,
    minWidth: 56,
    textAlign: 'right',
  },
  occLineup: {
    fontFamily: fontFamily.body,
    fontSize: 12.5,
    letterSpacing: -0.06,
  },

  // Lineup — wie er optreedt op de eerstvolgende occurrence.
  // Container-stijl matcht occList + crewBlock voor visuele rust.
  // Headliner krijgt grotere display-font, support/dj kleiner.
  lineupHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 26,
    marginBottom: 6,
  },
  lineupKicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  lineupBlock: {
    marginTop: 6,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  lineupRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  lineupName: {
    flex: 1,
  },
  lineupRole: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  // Notice wanneer ?o= naar een afgelopen occurrence verwees, of het
  // hele event al voorbij is. In accent-kleur voor meer aandacht;
  // platte regel met hairline-divider eronder, zelfde patroon als
  // de genre-pills bovenaan.
  expiredNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
  },
  expiredNoticeText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 17,
    letterSpacing: -0.13,
  },

  // Crew + invite — visueel één container met afgeronde hoeken op de
  // buitenrand. Crew-rijen bovenin (hairline-scheidingen), invite-CTA
  // onderin met een border-top die dezelfde tone heeft als de rij-
  // separators. Bij geen crew krijgt het hele blok automatisch z'n
  // ronde hoeken aan top én bottom — invite staat dan alleen.
  crewInviteContainer: {
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  crewInviteCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  crewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  crewAv: { width: 32, height: 32, borderRadius: 999 },
  crewAvFallback: { alignItems: 'center', justifyContent: 'center' },
  crewAvInitial: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 14.5,
  },
  crewName: {
    fontFamily: fontFamily.medium,
    fontSize: 14,
    letterSpacing: -0.14,
  },
  crewVia: {
    fontFamily: fontFamily.mono,
    fontSize: 9.5,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  crewPill: {
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  crewPillText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 9,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },

  // Loading / error fallback
  fallbackBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  fallbackText: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    textAlign: 'center',
    lineHeight: 18,
  },
  fallbackBackBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackAction: {
    alignSelf: 'center',
    marginTop: 18,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
  },
  fallbackActionText: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },

  // Invite tekst + chevron — gedeeld met series-pill voor visuele consistency.
  inviteText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
  inviteChev: { fontFamily: fontFamily.mono, fontSize: 14 },

  // Tickets als één full-width CTA met titel + subtitle binnen de
  // button zelf. Geen aparte section-heading — de button bevat al
  // "Tickets". Disabled-variant voor sold-out / geen ticketUrl.
  ticketsBigCta: {
    marginTop: 26,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  ticketsBigCtaContent: { flex: 1 },
  ticketsBigCtaTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    letterSpacing: -0.2,
  },
  ticketsBigCtaSubtitle: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    letterSpacing: -0.07,
  },
  ticketsBigCtaArrow: {
    fontFamily: fontFamily.mono,
    fontSize: 14,
    marginLeft: 12,
  },
  ticketsBigCtaDisabled: {
    marginTop: 26,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'flex-start',
  },
});
