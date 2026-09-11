import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SpinningCross } from '@/components/SpinningCross';
import { dowMixed, monthShort } from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { usePendingEvents, useTogglePendingGoing } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { useTicketsFor } from '@/store/tickets';
import { fontFamily, palette } from '@/theme/tokens';
import { TONE, type BadgeToneKey } from '@/theme/tones';

/**
 * Detailpagina van een event dat je zelf hebt toegevoegd.
 *
 * Eén op één dezelfde opbouw als [`event/[id]`](../event/[id]/index.tsx):
 * hero met de titel eronder, dan je ticket, dan datum/aanvang/venue in
 * drie cellen. Alleen de helft van de inhoud bestaat nog niet — geen
 * beschrijving, geen lineup, geen vrienden — en in plaats van een foto
 * staat de eerste letter op een kleurvlak, dezelfde kleur als in je
 * plannenlijst.
 *
 * Leest uit `/submissions/mine`: je ziet alleen wat je zelf hebt
 * toegevoegd of waar je aan hebt gehangen.
 */

const HERO_HEIGHT = 320;

/** Zelfde tonen en dezelfde hash als in de plannenlijst, zodat de kleur
    van een avond overal gelijk is. */
const PENDING_TONES: BadgeToneKey[] = [
  'acid',
  'flare',
  'plum',
  'azure',
  'saffron',
  'cobalt',
];

function hashTone(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export default function PendingEventScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = raw ?? '';
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();

  const { data, isLoading } = usePendingEvents();
  const toggle = useTogglePendingGoing();
  const tickets = useTicketsFor(id);
  const pending = (data ?? []).find((p) => p.id === id) ?? null;

  const title =
    pending?.title ?? pending?.artists[0] ?? t('Naamloos', 'Untitled');
  const tone = PENDING_TONES[hashTone(id) % PENDING_TONES.length];
  const when = pending?.date ? new Date(`${pending.date}T12:00:00`) : null;
  const dateLabel =
    when && !Number.isNaN(when.getTime())
      ? `${dowMixed(when.getDay(), locale)} ${when.getDate()} ${monthShort(
          when.getMonth(),
          locale,
        )} ${when.getFullYear()}`
      : '—';

  const onRemove = () => {
    Alert.alert(
      t('Uit je plannen halen?', 'Remove from your plans?'),
      t(
        'Je ticket blijft op je toestel staan.',
        'Your ticket stays on your device.',
      ),
      [
        { text: t('Laat staan', 'Keep it'), style: 'cancel' },
        {
          text: t('Weghalen', 'Remove'),
          style: 'destructive',
          onPress: () => {
            toggle.mutate({ id, going: false });
            safeBack();
          },
        },
      ],
    );
  };

  if (isLoading && !pending) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: roles.bg }]}>
        <SpinningCross size={26} color={roles.fgMuted} />
      </View>
    );
  }

  if (!pending) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: roles.bg }]}>
        <Text style={[styles.bodyText, { color: roles.fgMuted }]}>
          {t('Dit plan is er niet meer.', 'This plan is gone.')}
        </Text>
        <Pressable onPress={() => safeBack()} hitSlop={8}>
          <Text style={[styles.bodyText, { color: roles.accent }]}>
            {t('Terug', 'Back')}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {/* Vast vlak achter de content, net als de hero-foto op een
          eventpagina. Geen beeld, dus de letter groot en scheef over de
          rand — dat is leuker dan een lege kleurvlek. */}
      <View style={[styles.heroPinned, { backgroundColor: TONE[mode][tone] }]}>
        <Text style={styles.heroLetter}>{title.trim().charAt(0)}</Text>
        <LinearGradient
          colors={
            isNacht
              ? [
                  'rgba(10,10,11,0.15)',
                  'rgba(10,10,11,0.5)',
                  'rgba(10,10,11,0.95)',
                ]
              : ['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.25)', 'rgba(0,0,0,0.7)']
          }
          locations={[0, 0.45, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      </View>

      <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => safeBack()}
          hitSlop={10}
          style={styles.circleBtn}
        >
          <Ionicons name="chevron-back" size={22} color={palette.ink} />
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={10} style={styles.circleBtn}>
          <Ionicons name="trash-outline" size={19} color={palette.ink} />
        </Pressable>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      >
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
                {t('Zelf toegevoegd', 'Added by you')}
              </Text>
            </View>
            <Text style={styles.heroTitle}>{title}</Text>
          </View>
        </View>

        <View style={[styles.body, { backgroundColor: roles.bg }]}>
          {/* Zelfde plek en zelfde vorm als op een eventpagina: het eerste
              wat je ziet, want dit is wat je bij de deur nodig hebt. */}
          {tickets.length > 0 ? (
            <Pressable
              onPress={() => router.push(`/ticket/${id}` as never)}
              style={[styles.ticketCta, { backgroundColor: roles.accent }]}
            >
              <Ionicons name="ticket" size={19} color={roles.onAccent} />
              <Text style={[styles.ticketCtaText, { color: roles.onAccent }]}>
                {tickets.length > 1
                  ? t(
                      `Toon ${tickets.length} tickets`,
                      `Show ${tickets.length} tickets`,
                    )
                  : t('Toon ticket', 'Show ticket')}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={17}
                color={roles.onAccent}
              />
            </Pressable>
          ) : null}

          <View style={styles.metaRow}>
            <View style={styles.metaCellWrap}>
              <MetaCell label={t('Datum', 'Date')} value={dateLabel} />
            </View>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={t('Aanvang', 'Doors')}
                value={pending.time ?? '—'}
              />
            </View>
            <View style={styles.metaCellWrap}>
              <MetaCell
                label={t('Venue', 'Venue')}
                value={pending.venue ?? pending.city ?? '—'}
              />
            </View>
          </View>

          <Text style={[styles.bodyText, { color: roles.fgMuted }]}>
            {t(
              'Dit event heb je zelf toegevoegd, dus verder is het hier nog leeg. Andreas maakt er een echt event van; dan komt de rest erbij — beeld, tijden, en wie er nog heen gaan.',
              'You added this event yourself, so the rest is still empty. Andreas will turn it into a real event; then the rest follows — images, times, and who else is going.',
            )}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  const mode = useMode();
  const roles = useRoles();
  const isNacht = mode === 'nacht';
  return (
    <View
      style={[
        styles.metaCell,
        {
          backgroundColor: isNacht ? '#101012' : palette.paper2,
          borderColor: isNacht ? '#232327' : palette.paper,
        },
      ]}
    >
      <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center', gap: 12 },

  heroPinned: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HERO_HEIGHT,
    overflow: 'hidden',
  },
  // Buiten de rand en gedraaid: een letter die netjes gecentreerd staat
  // leest als een avatar, en dit is geen avatar maar een affiche dat er
  // nog niet is.
  heroLetter: {
    position: 'absolute',
    right: -18,
    top: -40,
    fontFamily: fontFamily.display,
    fontSize: 300,
    lineHeight: 300,
    color: 'rgba(0,0,0,0.18)',
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  circleBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroSpacer: {
    height: HERO_HEIGHT,
    paddingHorizontal: 18,
    paddingBottom: 20,
    justifyContent: 'flex-end',
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

  body: { padding: 20 },
  // Zelfde vorm als `myTicketCta` op de eventpagina.
  ticketCta: {
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderRadius: 8,
  },
  ticketCtaText: { flex: 1, fontFamily: fontFamily.bold, fontSize: 15.5 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginBottom: 20,
  },
  metaCellWrap: { flex: 1 },
  metaCell: { flex: 1, padding: 10, borderRadius: 8, borderWidth: 1 },
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
  bodyText: { fontFamily: fontFamily.body, fontSize: 14.5, lineHeight: 20.8 },
});
