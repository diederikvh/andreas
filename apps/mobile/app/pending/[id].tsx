import { Ionicons } from '@expo/vector-icons';
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

import { Cross } from '@/components/Cross';
import { SpinningCross } from '@/components/SpinningCross';
import { dowMixed, monthShort } from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import { safeBack } from '@/lib/navigation';
import { usePendingEvents, useTogglePendingGoing } from '@/lib/queries';
import { useTicketsFor } from '@/store/tickets';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * Detailpagina van een event dat Andreas nog niet kent.
 *
 * Bewust karig: er is geen beschrijving, geen lineup en geen beeld, want
 * niemand heeft die ingevuld — alleen wat jij van het affiche of het
 * ticket hebt overgenomen. Wat hier wél moet kunnen is het enige dat aan
 * de deur telt: je ticket tevoorschijn halen.
 *
 * Leest uit `/submissions/mine`, dus je ziet alleen aanmeldingen waar je
 * zelf heen gaat. Er is geen publieke detail-route voor andermans
 * aanmeldingen en die hoort er ook niet te zijn.
 */
export default function PendingEventScreen() {
  const { id: raw } = useLocalSearchParams<{ id: string }>();
  const id = raw ?? '';
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();

  const { data, isLoading } = usePendingEvents();
  const toggle = useTogglePendingGoing();
  const tickets = useTicketsFor(id);
  const pending = (data ?? []).find((p) => p.id === id) ?? null;

  const when = pending?.date ? new Date(`${pending.date}T12:00:00`) : null;
  const dateLabel =
    when && !Number.isNaN(when.getTime())
      ? `${dowMixed(when.getDay(), locale)} ${when.getDate()} ${monthShort(
          when.getMonth(),
          locale,
        )} ${when.getFullYear()}`
      : null;

  const onRemove = () => {
    Alert.alert(
      t('Uit je plannen halen?', 'Remove from your plans?'),
      t(
        'De aanmelding blijft staan, jij gaat er alleen niet meer heen.',
        'The submission stays, you just stop going.',
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

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => safeBack()} hitSlop={10} style={styles.round}>
          <Ionicons name="chevron-back" size={22} color={roles.fg} />
        </Pressable>
        {pending ? (
          <Pressable onPress={onRemove} hitSlop={10} style={styles.round}>
            <Ionicons name="trash-outline" size={19} color={roles.fgMuted} />
          </Pressable>
        ) : null}
      </View>

      {isLoading && !pending ? (
        <View style={styles.center}>
          <SpinningCross size={26} color={roles.fgMuted} />
        </View>
      ) : !pending ? (
        <View style={styles.center}>
          <Text style={[styles.lead, { color: roles.fgMuted }]}>
            {t('Dit plan is er niet meer.', 'This plan is gone.')}
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Geen beeld, dus het kruis — zelfde gebaar als op de
              plannenlijst, alleen groter. */}
          <View style={[styles.hero, { backgroundColor: roles.bgChip }]}>
            <Cross size={54} thickness={15} color={roles.fgPlaceholder} />
          </View>

          <View style={styles.body}>
            <Text style={[styles.kicker, { color: roles.fgMuted }]}>
              {t('Nog niet bekend bij Andreas', 'Not known to Andreas yet')}
            </Text>
            <Text style={[styles.title, { color: roles.fg }]}>
              {pending.title ?? pending.artists[0] ?? t('Naamloos', 'Untitled')}
            </Text>

            {tickets.length > 0 ? (
              <Pressable
                onPress={() => router.push(`/ticket/${id}` as never)}
                style={[styles.cta, { backgroundColor: roles.accent }]}
              >
                <Ionicons name="ticket" size={19} color={roles.onAccent} />
                <Text style={[styles.ctaText, { color: roles.onAccent }]}>
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

            <View style={styles.meta}>
              <MetaRow label={t('Datum', 'Date')} value={dateLabel} />
              <MetaRow
                label={t('Aanvang', 'Doors')}
                value={pending.time ?? null}
              />
              <MetaRow label={t('Venue', 'Venue')} value={pending.venue} />
              <MetaRow label={t('Stad', 'City')} value={pending.city} />
            </View>

            <Text style={[styles.lead, { color: roles.fgMuted }]}>
              {t(
                'Je hebt dit zelf toegevoegd. Andreas kijkt ernaar en maakt er een echt event van — dan komt alles erbij: beeld, tijden en wie er nog heen gaat.',
                'You added this yourself. Andreas will look at it and turn it into a real event — then the rest follows: images, times and who else is going.',
              )}
            </Text>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null }) {
  const roles = useRoles();
  if (!value) return null;
  return (
    <View style={[styles.metaRow, { borderColor: roles.bgChip }]}>
      <Text style={[styles.metaLabel, { color: roles.fgMuted }]}>{label}</Text>
      <Text style={[styles.metaValue, { color: roles.fg }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  round: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  hero: {
    height: 180,
    marginHorizontal: 22,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { paddingHorizontal: 22, paddingTop: 18, gap: 14 },
  kicker: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  title: {
    fontFamily: fontFamily.display,
    fontSize: 30,
    lineHeight: 30 * 0.94,
    letterSpacing: -1.1,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderRadius: 999,
  },
  ctaText: { flex: 1, fontFamily: fontFamily.bold, fontSize: 15.5 },
  meta: { gap: 0 },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  metaLabel: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  metaValue: { fontFamily: fontFamily.bold, fontSize: 15, letterSpacing: -0.2 },
  lead: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
});
