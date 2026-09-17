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
  Alert,
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

import { EventReminder } from '@/components/EventReminder';
import {
  ICON_INSET,
  SettingsAction,
  SettingsGroup,
} from '@/components/SettingsList';
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
  formatPlace,
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
  useMyGoing,
  useMySaves,
  useRespondInvitation,
  useToggleGoing,
  useToggleSave,
} from '@/lib/queries';
import {
  isSaveSource,
  type ApiInvitation,
  type InvitationStatus,
} from '@/lib/api';
import { useMode, useRoles } from '@/store/mode';
import { useTicketFor, useTicketsFor } from '@/store/tickets';
import { fontFamily, palette } from '@/theme/tokens';

const HERO_HEIGHT = 420;

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
  const navSource = isSaveSource(rawSource) ? rawSource : null;
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
      Extrapolation.CLAMP,
    ),
  }));
  const heroStyle = useAnimatedStyle(() => {
    const offset = Math.min(0, scrollY.value);
    const scale = 1 - offset / HERO_HEIGHT;
    return {
      transform: [{ translateY: ((scale - 1) * HERO_HEIGHT) / 2 }, { scale }],
    };
  });

  const { data: event, isLoading, error } = useEvent(id);
  const { data: invitations } = useInvitations();

  const selectedOccurrenceId =
    targetOccurrenceId &&
    event?.occurrences?.find((o) => o.id === targetOccurrenceId)
      ? targetOccurrenceId
      : (event?.occurrences?.[0]?.id ?? null);

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
        inv.occurrence.id === selectedOccurrenceId,
    ) ?? null;
  // Heeft de gebruiker voor dit moment een ticket in Andreas gezet? Dat
  // bestand staat alleen op dit toestel (zie store/tickets.ts) — de server
  // weet er niets van, dus dit is puur lokale state.
  //
  // Let op de plek: boven de early returns hieronder. Een hook achter een
  // return is precies de fout die eslint in dit bestand al eerder ving.
  const myTickets = useTicketsFor(selectedOccurrenceId);
  const myTicket = myTickets[0];

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
      <DetailFallback tone="error">
        Dit event is niet beschikbaar.
      </DetailFallback>
    );
  }

  const hasActuele = (event.occurrences?.length ?? 0) > 0;
  const eventOver = !hasActuele;
  const targetMissed =
    targetOccurrenceId !== null &&
    hasActuele &&
    !event.occurrences!.some((o) => o.id === targetOccurrenceId);
  const selectedOccurrence = selectedOccurrenceId
    ? (event.occurrences?.find((o) => o.id === selectedOccurrenceId) ?? null)
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
              ? [
                  'rgba(10,10,11,0.4)',
                  'rgba(10,10,11,0.2)',
                  'rgba(10,10,11,0.95)',
                ]
              : [
                  'rgba(45,74,62,0.4)',
                  'rgba(45,74,62,0.3)',
                  'rgba(45,74,62,0.85)',
                ]
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
          {/* Bovenaan, boven datum/tijd/venue en alles daarna: dit is wat
              je nodig hebt als je bij de deur staat — niet iets om eerst
              genres, een beschrijving en een lineup voor door te
              scrollen. */}
          {myTicket && (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                router.push(`/ticket/${myTicket.occurrenceId}` as never);
              }}
              style={[styles.myTicketCta, { backgroundColor: roles.accent }]}
            >
              <Ionicons name="ticket" size={19} color={roles.onAccent} />
              <Text style={[styles.myTicketCtaText, { color: roles.onAccent }]}>
                {myTickets.length > 1
                  ? t(
                      `Toon ${myTickets.length} tickets`,
                      `Show ${myTickets.length} tickets`,
                    )
                  : t('Toon ticket', 'Show ticket')}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={17}
                color={roles.onAccent}
              />
            </Pressable>
          )}

          {event.series && event.series.length > 0 && (
            <>
              {/* Alleen series hier bovenaan — context ("dit hoort bij
                  ADE") weegt zwaarder dan genre. Border ipv solid bg om
                  duidelijk te maken dat ze klikbaar zijn. De genre-pills
                  staan onder het meta-blok. */}
              <View style={styles.genreRow}>
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
              </View>
              <View
                style={[styles.divider, { backgroundColor: roles.bgChip }]}
              />
            </>
          )}

          {(eventOver || targetMissed) && (
            <>
              <View style={styles.expiredNotice}>
                <Ionicons name="time-outline" size={14} color={roles.accent} />
                <Text
                  style={[styles.expiredNoticeText, { color: roles.accent }]}
                >
                  {eventOver
                    ? t('Dit event is afgelopen.', 'This event is over.')
                    : t(
                        'De voorstelling die je selecteerde is voorbij. Dit is de eerstvolgende.',
                        'The performance you selected is over. This is the next one.',
                      )}
                </Text>
              </View>
              <View
                style={[styles.divider, { backgroundColor: roles.bgChip }]}
              />
            </>
          )}

          {/* Twee rijen van twee. Was één rij van drie, maar dan is de
              venue-cel een derde breed en breekt een naam als
              "Het Concertgebouw" met z'n plaats eronder over vier
              regels. Nu staat de plaats naast de venue in plaats van
              eronder. */}
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
          </View>
          {/* Locatie links, venue rechts: dan staat de chevron aan de
              buitenrand van de rij in plaats van er middenin. */}
          {/* Staan er genre-pills onder, dan hoort die rij nog bij dit
              blok: dezelfde 8pt als tussen de twee meta-rijen, en de
              afsluitende marge komt van de pill-rij zelf. */}
          <View
            style={[
              styles.metaRow,
              event.genres && event.genres.length > 0
                ? styles.metaRowBeforeGenres
                : styles.metaRowLast,
            ]}
          >
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={t('Locatie', 'Location')}
                value={view.venuePlace ?? '—'}
              />
            </View>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={t('Venue', 'Venue')}
                value={view.venue}
                chevron
                onPress={() => router.push(`/venue/${event.venue.slug}`)}
              />
            </View>
          </View>

          {/* Genre onder de vier meta-cellen: de hero-tag zegt welke
              categorie het is, dit zegt wát voor avond binnen die
              categorie. Boven het meta-blok vocht het met de
              series-pills om dezelfde strip. */}
          {event.genres && event.genres.length > 0 && (
            <View style={styles.genreRowUnderMeta}>
              {event.genres.map((g) => (
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
          )}

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

          {selectedOccurrence?.lineup &&
            selectedOccurrence.lineup.length > 0 && (
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
            onNeedsRoom={(overflow) =>
              scrollRef.current?.scrollTo({
                y: scrollY.value + overflow,
                animated: true,
              })
            }
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
              secondary={Boolean(myTicket)}
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
  user: {
    id: string;
    name: string;
    handle: string | null;
    avatarUrl: string | null;
  };
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
                  `VIA ${invite.group.name.toUpperCase()}`,
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
          placeholder={t('kort antwoord (optioneel)', 'short reply (optional)')}
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
  onNeedsRoom,
}: {
  event: ApiEvent;
  selectedOccurrence: ApiOccurrence | null;
  onInvite: () => void;
  onNeedsRoom?: (overflow: number) => void;
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
          (inv) => inv.occurrenceId === selectedOccurrence.id,
        )
      : (event.myInvites ?? []);
    const incomingAccepted = selectedOccurrence
      ? (event.incomingAcceptedInvites ?? []).filter(
          (inv) => inv.occurrenceId === selectedOccurrence.id,
        )
      : (event.incomingAcceptedInvites ?? []);
    const occPeopleGoing = selectedOccurrence
      ? (event.peopleGoing ?? []).filter(
          (p) => p.occurrenceId === selectedOccurrence.id,
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
          inv.myStatus === 'going',
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
      (a, b) => order(a) - order(b) || a.user.name.localeCompare(b.user.name),
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

  // Synthetische "::next"-occurrences hebben geen echte id, dus daar valt
  // niks op te markeren.
  const canMarkGoing = Boolean(
    selectedOccurrence && !selectedOccurrence.id.endsWith('::next'),
  );

  return (
    <>
      {/* Niet "Vrienden": onder deze kop staat eerst of jij gaat, en pas
          daarna wie er nog meer bij zijn. Eén container, twee keuzes —
          ik ga, en ik neem iemand mee. */}
      <Text style={[styles.crewHeading, { color: roles.fg }]}>
        {t('Jouw plan', 'Your plan')}
      </Text>
      {/* Zelfde blok als het profielmenu en de instellingen: dit is óók
          een lijstje waar je iets uit kiest. De stand staat rechts --
          "Ja" als je gaat, het moment als er een herinnering staat --
          zodat je in één blik ziet wat er al geregeld is. Wie er meegaan
          staan ertussen, want dat zijn geen knoppen maar mensen. */}
      <SettingsGroup inset={ICON_INSET} style={styles.planGroup}>
        {canMarkGoing ? (
          <GoingRow occurrenceId={selectedOccurrence!.id} />
        ) : null}
        {rows.map((row) => (
          <CrewRowItem key={row.user.id} row={row} first eventId={event.id} />
        ))}
        <SettingsAction
          icon="person-add-outline"
          label={t('Nodig iemand uit', 'Invite someone')}
          onPress={onInvite}
        />
        {selectedOccurrence && !selectedOccurrence.id.endsWith('::next') ? (
          <EventReminder
            occurrenceId={selectedOccurrence.id}
            startsAt={selectedOccurrence.startsAt ?? null}
            endsAt={selectedOccurrence.endsAt ?? null}
            onNeedsRoom={onNeedsRoom}
          />
        ) : null}
      </SettingsGroup>
    </>
  );
}

/**
 * "Ik ga hierheen" — de trede tussen een hartje en een uitnodiging.
 *
 * Zit in dezelfde container als de crew en de invite-knop: onder één kop
 * kies je of jij gaat en wie je meeneemt. Bewust geen vijfde icoontje in
 * de actie-rij bovenaan — een hartje leest iedereen, een glyph voor
 * intentie niet.
 */
function GoingRow({
  occurrenceId,
}: {
  occurrenceId: string;
}) {
  const roles = useRoles();
  const t = useT();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: going } = useMyGoing({ enabled: authed });
  const toggle = useToggleGoing();
  const ticket = useTicketFor(occurrenceId);

  const isGoing = Boolean(going?.some((g) => g.occurrenceId === occurrenceId));

  const onPress = () => {
    // Going uitzetten terwijl er een ticket aan hangt kan niet: tickets
    // hangen aan "ik ga", dus dat zou je kaartje meesleuren. Eén tik en je
    // bent het kwijt is geen acceptabele manier om data te verliezen — en
    // de omgekeerde route (eerst ticket weg, dan going uit) is bewust een
    // stap meer.
    if (isGoing && ticket) {
      Alert.alert(
        t('Je hebt hier een ticket', 'You have a ticket for this'),
        t(
          'Je ticket hangt aan "ik ga". Verwijder eerst je ticket als je dit plan wil afzeggen.',
          'Your ticket is attached to "going". Remove your ticket first if you want to cancel this plan.',
        ),
        [
          { text: t('Laat staan', 'Keep it'), style: 'cancel' },
          {
            text: t('Ticket bekijken', 'View ticket'),
            onPress: () => router.push(`/ticket/${occurrenceId}` as never),
          },
        ],
      );
      return;
    }
    Haptics.impactAsync(
      isGoing
        ? Haptics.ImpactFeedbackStyle.Light
        : Haptics.ImpactFeedbackStyle.Medium,
    );
    toggle.mutate({ occurrenceId, source: 'other' });
  };

  return (
    <SettingsAction
      icon={isGoing ? 'checkmark-circle' : 'checkmark-circle-outline'}
      label={isGoing ? t('Je gaat hierheen', "You're going") : t('Ik ga hierheen', "I'm going")}
      value={isGoing ? t('Ja', 'Yes') : undefined}
      onPress={onPress}
    />
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
        <Text numberOfLines={1} style={[styles.crewName, { color: roles.fg }]}>
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
              {entry.role && (
                <View
                  style={[
                    styles.lineupRolePill,
                    { backgroundColor: roles.bgChip },
                  ]}
                >
                  <Text
                    style={[
                      styles.lineupRolePillText,
                      { color: roles.fgMuted },
                    ]}
                  >
                    {ROLE_LABEL[entry.role]}
                  </Text>
                </View>
              )}
              {entry.artistId && (
                <Ionicons name="chevron-forward" size={16} color={roles.fg} />
              )}
            </>
          );
          const rowStyle = [
            styles.lineupRow,
            i > 0 && {
              borderTopColor: roles.bgChip,
              borderTopWidth: StyleSheet.hairlineWidth,
            },
          ];
          // Klikbaar alleen als we een artist-record hebben — eerlijk
          // signaal dat er een echte pagina achter zit. Anders gewoon
          // tekst (geen valse beloftes).
          if (entry.artistId) {
            return (
              <Pressable
                key={`${entry.name}-${i}`}
                onPress={() =>
                  router.push(`/artist/${entry.artistId}` as never)
                }
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
  secondary,
}: {
  price: string;
  priceNote: string | null;
  ticketUrl: string | null;
  isNacht: boolean;
  soldOut: boolean;
  /** Er hangt al een ticket aan deze avond, dus "Toon ticket" is de
      hoofdknop. Dan kan deze niet óók vol accent zijn: één knop per
      pagina die om aandacht vraagt. Kopen blijft mogelijk — je gaat
      met iemand mee, of je hebt er nog één nodig. */
  secondary: boolean;
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
        {
          backgroundColor: secondary
            ? roles.bgChip
            : isNacht
              ? palette.acid
              : palette.soil,
        },
      ]}
    >
      <View style={styles.ticketsBigCtaContent}>
        <Text
          style={[
            styles.ticketsBigCtaTitle,
            {
              color: secondary
                ? roles.fg
                : isNacht
                  ? palette.noir
                  : palette.paper3,
            },
          ]}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            style={[
              styles.ticketsBigCtaSubtitle,
              {
                color: secondary
                  ? roles.fgMuted
                  : isNacht
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
          {
            color: secondary
              ? roles.fgMuted
              : isNacht
                ? palette.noir
                : palette.paper3,
          },
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
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
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
  /** "Amsterdam · Noord" — null als de venue geen plaats heeft. */
  venuePlace: string | null;
  description: string | null;
  photo: string | null;
  price: string;
  priceNote: string | null;
};

function toViewModel(
  event: ApiEvent,
  occ: ApiOccurrence | null,
  locale: Locale,
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
    // Plaats van de venue die deze rij tóónt — bij films is dat de
    // bioscoop, niet de venue die het event scrapete.
    venuePlace: formatPlace(
      occ?.venue?.city ?? event.venue.city,
      occ?.venue?.wijk ?? event.venue.wijk
    ),
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
      onPress={() => {
        // Linking.openURL pakt op iOS de YouTube-app als die
        // geinstalleerd is (YouTube-app-claim op youtu.be /
        // youtube.com Universal Links). Anders valt 't terug op
        // de browser. WebBrowser.openBrowserAsync zou altijd in
        // de in-app browser openen — minder fijn voor video.
        Linking.openURL(trailerUrl).catch(() => {
          WebBrowser.openBrowserAsync(trailerUrl).catch(() => {});
        });
      }}
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
            style={[styles.trailerThumb, { backgroundColor: roles.bgChip }]}
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
  const locale = useLocale();
  const onPress = async () => {
    const params = new URLSearchParams();
    if (session?.user?.id) params.set('ref', session.user.id);
    if (locale === 'en') params.set('lang', 'en');
    const qs = params.toString();
    const url = `https://andreas.amsterdam/e/${encodeURIComponent(event.id)}${qs ? `?${qs}` : ''}`;
    const messageBody = t(
      `Ik ga naar ${event.title} via Andreas. Wil je mee?\n${url}`,
      `I’m going to ${event.title} via Andreas. Want to come?\n${url}`,
    );
    try {
      await Share.share(
        Platform.OS === 'ios'
          ? { url, message: messageBody }
          : { message: messageBody },
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
    occurrenceId && saves?.some((s) => s.occurrenceId === occurrenceId),
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
      withTiming(1, { duration: 180 }),
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
  chevron,
  onPress,
}: {
  label: string;
  value: string;
  /** Pijltje rechtsonder. Markeert dat de cel ergens heen gaat, in
      plaats van de hele rand te laten oplichten — dat trok meer
      aandacht dan de titel erboven. */
  chevron?: boolean;
  onPress?: () => void;
}) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  const Wrap = onPress ? Pressable : View;
  const borderColor = isNacht ? '#232327' : palette.paper;
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
      {/* Rij over de hele cel, niet alleen over de waarde: zo staat de
          chevron verticaal in het midden van het kader in plaats van op
          de onderregel te hangen. */}
      <View style={styles.metaCellInner}>
        <View style={styles.metaCellText}>
          <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>
            {label}
          </Text>
          <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
        </View>
        {chevron ? (
          <Ionicons name="chevron-forward" size={14} color={roles.fgMuted} />
        ) : null}
      </View>
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
    marginBottom: 8,
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
  metaCellInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // flexShrink zodat een lange venue-naam afbreekt in plaats van de
  // chevron uit de cel te duwen.
  metaCellText: { flex: 1, flexShrink: 1 },
  // De tweede rij draagt de ruimte naar wat eronder komt; de eerste
  // houdt alleen de 8 tussen de twee rijen.
  metaRowLast: { marginBottom: 20 },
  // Tussen de 20pt van metaRowLast (las als eigen blok) en de 8pt van
  // een meta-rij onderling (plakte tegen de kaders aan).
  metaRowBeforeGenres: { marginBottom: 14 },

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
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
  // Zelfde rij-stijl als de series-strip, maar met marge boven i.p.v.
  // alleen eronder — het meta-blok sluit strak af.
  genreRowUnderMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 20,
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
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    // Ruimer dan 11 — minder krampachtig, lineup-rijen lezen rustiger.
    paddingVertical: 16,
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
  // Pill om de role-tekst zodat 'ie als visueel label leest, niet als
  // plain tekst. Consistent met andere kleine labels in de app
  // (chips op Vandaag-rails, genre-tags op artist-page).
  lineupRolePill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  lineupRolePillText: {
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
  planGroup: { marginTop: 6, paddingHorizontal: 0 },
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
    gap: 7,
    paddingLeft: 11,
    paddingRight: 16,
    paddingVertical: 11,
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
  myTicketCta: {
    // `body` heeft al padding 20; een eigen marge zou de knop 40 naar
    // binnen zetten terwijl de meta-cells erboven op 20 staan.
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderRadius: 8,
  },
  myTicketCtaText: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.15,
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
