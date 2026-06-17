/**
 * De Andreas-gids als in-place overlay (zelfde "vibe" als SearchOverlay):
 * backdrop fade-in + sheet slide-up. Conversationele uitgaans-zoek — één
 * invoerveld, een gesprek, en eventkaarten die UIT de DB-events (`ApiEvent`)
 * worden gerenderd, nooit uit de model-tekst (brief §8).
 *
 * Profiel + history leven in de zoek-store; de server is stateless. De
 * conversatie blijft staan tussen openen/sluiten (geen reset on close).
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EventListRow } from '@/components/EventListRow';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiEvent } from '@/lib/api';
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
import type { BadgeTone } from '@/lib/types';
import { useMode, useRoles } from '@/store/mode';
import { useZoekStore, type ChatMessage } from '@/store/zoek';
import { fontFamily, palette } from '@/theme/tokens';

const ENTER_MS = 260;
const EXIT_MS = 200;

const SUGGESTIONS_NL = [
  'techno, niet te ver',
  'iets rustigs vanavond',
  'film in de buurt',
  'wat kan ik dit weekend doen?',
];
const SUGGESTIONS_EN = [
  'techno, not too far',
  'something low-key tonight',
  'a film nearby',
  "what's on this weekend?",
];

export function GuideOverlay({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();

  const messages = useZoekStore((s) => s.messages);
  const sending = useZoekStore((s) => s.sending);
  const error = useZoekStore((s) => s.error);
  const send = useZoekStore((s) => s.send);
  const reset = useZoekStore((s) => s.reset);

  const [input, setInput] = useState('');
  const [mounted, setMounted] = useState(visible);
  const [kbHeight, setKbHeight] = useState(0);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Zelf toetsenbordhoogte tracken i.p.v. KeyboardAvoidingView: die werkt
  // niet betrouwbaar binnen een absolute sheet (zie CLAUDE.md). We zetten
  // de dock via marginBottom boven het toetsenbord.
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const backdrop = useSharedValue(0);
  const sheet = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      backdrop.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
      sheet.value = withTiming(1, { duration: ENTER_MS, easing: Easing.out(Easing.cubic) });
    } else {
      backdrop.value = withTiming(0, { duration: EXIT_MS, easing: Easing.in(Easing.cubic) });
      sheet.value = withTiming(
        0,
        { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setMounted)(false);
        }
      );
    }
  }, [visible, backdrop, sheet]);

  // Scroll mee naar onderen bij nieuwe berichten / tijdens het wachten.
  useEffect(() => {
    if (!visible) return;
    const tid = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(tid);
  }, [messages.length, sending, visible]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const submit = useCallback(
    (text: string) => {
      const v = text.trim();
      if (!v) return;
      setInput('');
      void send(v);
    },
    [send]
  );

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: sheet.value,
    transform: [{ translateY: (1 - sheet.value) * 24 }],
  }));

  if (!mounted) return null;

  const empty = messages.length === 0;

  return (
    <View style={styles.root} pointerEvents="box-none">
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: isNacht ? 'rgba(0,0,0,0.65)' : 'rgba(20,18,12,0.45)' },
          backdropStyle,
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { backgroundColor: roles.bg, paddingTop: insets.top }, sheetStyle]}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={handleClose}
            hitSlop={8}
            style={[styles.headerBtn, { backgroundColor: roles.bgLift }]}
          >
            <Ionicons name="chevron-down" size={22} color={roles.fg} />
          </Pressable>
          <Text style={[styles.title, { color: roles.fg }]}>{t('Gids', 'Guide')}</Text>
          <Pressable
            onPress={reset}
            hitSlop={8}
            style={[styles.headerBtn, { backgroundColor: roles.bgLift }]}
            disabled={empty}
          >
            <Ionicons name="refresh" size={18} color={empty ? roles.fgMuted : roles.fg} />
          </Pressable>
        </View>

        <View style={styles.flex}>
          {empty ? (
            <EmptyState onPick={submit} />
          ) : (
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              renderItem={({ item }) => <MessageBubble message={item} />}
              contentContainerStyle={styles.listContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              ListFooterComponent={
                sending ? (
                  <View style={styles.typing}>
                    <SpinningCross size={22} color={roles.accent} pulse />
                  </View>
                ) : null
              }
            />
          )}

          {error ? <Text style={[styles.error, { color: palette.red }]}>{error}</Text> : null}

          <View
            style={[
              styles.dock,
              {
                backgroundColor: roles.bg,
                // marginBottom tilt de dock boven het toetsenbord; als 't dicht
                // is houden we de home-indicator-inset aan.
                marginBottom: kbHeight,
                paddingBottom: kbHeight > 0 ? 8 : insets.bottom + 8,
              },
            ]}
          >
            <View
              style={[styles.inputWrap, { backgroundColor: roles.bgLift, borderColor: roles.bgChip }]}
            >
              <TextInput
                value={input}
                onChangeText={setInput}
                placeholder={t('Wat zoek je?', 'What are you after?')}
                placeholderTextColor={roles.fgMuted}
                style={[styles.input, { color: roles.fg }]}
                multiline
                returnKeyType="send"
                onSubmitEditing={() => submit(input)}
                editable={!sending}
              />
              <Pressable
                onPress={() => submit(input)}
                disabled={sending || input.trim().length === 0}
                hitSlop={6}
                style={[
                  styles.sendBtn,
                  {
                    backgroundColor:
                      input.trim().length === 0 || sending ? roles.bgChip : roles.accent,
                  },
                ]}
              >
                <Ionicons
                  name="arrow-up"
                  size={20}
                  color={input.trim().length === 0 || sending ? roles.fgMuted : roles.onAccent}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const roles = useRoles();
  const locale = useLocale();
  const t = useT();
  const suggestions = locale === 'nl' ? SUGGESTIONS_NL : SUGGESTIONS_EN;
  return (
    <View style={styles.emptyWrap}>
      <Text style={[styles.emptyTitle, { color: roles.fg }]}>
        {t('Vertel waar je zin in hebt', 'Tell me what you feel like')}
      </Text>
      <Text style={[styles.emptySub, { color: roles.fgMuted }]}>
        {t(
          'In gewone taal — ik zoek het echte aanbod van vanavond, dit weekend of verder bij elkaar.',
          "In plain words — I'll pull together what's actually on tonight, this weekend or beyond."
        )}
      </Text>
      <View style={styles.chips}>
        {suggestions.map((s) => (
          <Pressable
            key={s}
            onPress={() => onPick(s)}
            style={[styles.chip, { borderColor: roles.bgChip, backgroundColor: roles.bgLift }]}
          >
            <Text style={[styles.chipText, { color: roles.fg }]}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';

  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: roles.accent }]}>
          <Text style={[styles.userText, { color: isNacht ? palette.noir : '#fff' }]}>
            {message.text}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantWrap}>
      {message.text ? (
        <Text style={[styles.assistantText, { color: roles.fg }]}>{message.text}</Text>
      ) : null}
      {message.events.map((ev) => (
        <ZoekEventRow
          key={ev.id}
          event={ev}
          reason={message.reasonByEventId[ev.id]}
        />
      ))}
      {message.needsMoreInfo ? (
        <Text style={[styles.followup, { color: roles.fgMuted }]}>{message.needsMoreInfo}</Text>
      ) : null}
    </View>
  );
}

/** ApiEvent → EventListRow, identiek aan de mapping in SearchOverlay zodat de
    kaarten overal hetzelfde lezen. Toont de per-event reden eronder. */
function ZoekEventRow({
  event,
  reason,
}: {
  event: ApiEvent;
  reason?: string;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const start = event.startsAt;
  if (!start) return null;

  const venueTone =
    event.venue.type && (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeTone>)[event.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[event.category];
  const d = new Date(start);
  const dow = dowMixed(d.getDay(), locale);
  const month = monthShort(d.getMonth(), locale).toLowerCase();
  const time = rowTimeLabel(start, event.endsAt ?? null, locale);
  const dateLabel = `${dow} ${d.getDate()} ${month}`;

  return (
    <View style={styles.eventBlock}>
      <EventListRow
        thumb={eventImageUrl(event) ?? ''}
        thumbSize={96}
        title={event.title}
        venue={event.venue.name}
        venueTone={venueTone}
        time={time}
        dateLabel={dateLabel}
        dateAbove
        tags={[{ label: translateCategory(event.category, locale), tone }]}
        genreLabel={(event.genres ?? [])[0]}
        tick={tone}
        onPress={() => {
          // Alleen toetsenbord weg — overlay blijft open (zoals de zoek),
          // zodat je na 'terug' weer in je gesprek staat.
          Keyboard.dismiss();
          router.push(`/event/${event.id}?source=search` as never);
        }}
      />
      {reason ? <Text style={[styles.reason, { color: roles.fgMuted }]}>{reason}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 1000, elevation: 20 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.2,
        shadowOffset: { width: 0, height: -4 },
        shadowRadius: 16,
      },
      android: { elevation: 20 },
    }),
  },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: fontFamily.displayBold, fontSize: 18, letterSpacing: -0.36 },
  listContent: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 12 },
  emptyWrap: { flex: 1, paddingHorizontal: 30, justifyContent: 'center' },
  emptyTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 24,
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  emptySub: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20, marginBottom: 22 },
  chips: { gap: 10 },
  chip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: { fontFamily: fontFamily.medium, fontSize: 14 },
  userRow: { alignItems: 'flex-end', marginVertical: 6 },
  userBubble: {
    maxWidth: '86%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  },
  userText: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 20 },
  assistantWrap: { marginVertical: 6, gap: 8 },
  assistantText: { fontFamily: fontFamily.body, fontSize: 15, lineHeight: 21 },
  followup: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20, fontStyle: 'italic' },
  eventBlock: { marginHorizontal: -22 },
  reason: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 22,
    marginTop: -4,
    marginBottom: 6,
  },
  typing: { paddingVertical: 14, alignItems: 'flex-start' },
  error: { fontFamily: fontFamily.body, fontSize: 13, paddingHorizontal: 22, paddingBottom: 6 },
  dock: { paddingHorizontal: 18, paddingTop: 8 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 24,
    borderWidth: 1,
  },
  input: {
    flex: 1,
    fontFamily: fontFamily.body,
    fontSize: 15,
    lineHeight: 20,
    paddingVertical: 8,
    maxHeight: 120,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
