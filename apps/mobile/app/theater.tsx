/**
 * Andreas × Theater — overzicht van komende voorstellingen (~2 weken).
 * Single-column feed; per show landscape banner, titel, venue, alle
 * speeldata en discipline-chip. Bovenin filter-chips per discipline
 * (toneel / dans / cabaret / opera / familie) zodat je snel kan kiezen
 * wat je wil zien.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import type { ApiEvent } from '@/lib/api';
import {
  dowMixed,
  eventImageUrl,
  isMultiDay,
  monthShort,
} from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { useEvents } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

const HORIZONTAL_PADDING = 14;

type Discipline =
  | 'toneel'
  | 'dans'
  | 'cabaret'
  | 'opera'
  | 'familie'
  | 'overig';

const DISCIPLINE_LABELS: Record<Discipline, { nl: string; en: string }> = {
  toneel: { nl: 'Toneel', en: 'Theatre' },
  dans: { nl: 'Dans', en: 'Dance' },
  cabaret: { nl: 'Cabaret', en: 'Comedy' },
  opera: { nl: 'Opera', en: 'Opera' },
  familie: { nl: 'Familie', en: 'Family' },
  overig: { nl: 'Overig', en: 'Other' },
};

/** Map een event naar een primaire discipline op basis van z'n genres.
    Eerste-match wint — disciplines staan in volgorde van specificiteit
    (kindertheater eerst zodat 't niet als 'toneel' wordt geclassed). */
function disciplineFor(event: ApiEvent): Discipline {
  const genres = (event.genres ?? []).map((g) => g.toLowerCase());
  if (genres.some((g) => /kind|familie|family/.test(g))) return 'familie';
  if (genres.some((g) => /opera|musical|muziektheater/.test(g))) return 'opera';
  if (genres.some((g) => /cabaret|comedy|stand-?up|improv|drag/.test(g)))
    return 'cabaret';
  if (genres.some((g) => /dans|dance|ballet/.test(g))) return 'dans';
  if (genres.some((g) => /theater|toneel|drama|performance/.test(g)))
    return 'toneel';
  return 'overig';
}

export default function Theater() {
  const insets = useSafeAreaInsets();
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<Discipline | 'all'>('all');

  // Venster: komende 14 dagen. Theater wordt vaak weken vooruit
  // geboekt; 2 weken voelt als de juiste mix tussen "wat speelt nu"
  // en "ik wil iets plannen".
  const range = useMemo(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 14);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const { data: events, isLoading, error } = useEvents({
    from: range.from,
    to: range.to,
    category: 'Theater',
    limit: 2000,
  });

  // Dedupe op event-id, sorteer op eerstvolgende speeldatum. Een event
  // is alleen relevant voor discovery als 'ie minstens één occurrence
  // heeft die (a) nog komt en (b) korter dan een dag is — anders
  // staat 'r straks een card zonder data of klap je door op een
  // afgelopen voorstelling.
  const shows = useMemo<ApiEvent[]>(() => {
    if (!events) return [];
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const minMs = startOfToday.getTime();
    const seen = new Set<string>();
    const out: Array<{ event: ApiEvent; firstUpcoming: number }> = [];
    for (const e of events) {
      if (e.category !== 'Theater') continue;
      if (seen.has(e.id)) continue;
      const occs = e.occurrencesInRange ?? [];
      let firstUpcoming = Infinity;
      for (const o of occs) {
        if (isMultiDay(o.startsAt, o.endsAt)) continue;
        const ts = new Date(o.startsAt).getTime();
        if (ts < minMs) continue;
        if (ts < firstUpcoming) firstUpcoming = ts;
      }
      if (firstUpcoming === Infinity) continue;
      seen.add(e.id);
      out.push({ event: e, firstUpcoming });
    }
    return out
      .sort((a, b) => a.firstUpcoming - b.firstUpcoming)
      .map((x) => x.event);
  }, [events]);

  const filtered = useMemo(() => {
    if (selected === 'all') return shows;
    return shows.filter((s) => disciplineFor(s) === selected);
  }, [shows, selected]);

  // Tel per discipline om lege chips weg te laten (geen 'opera' chip
  // tonen als er deze 2 weken niets is). Volgorde is vaste discipline-
  // hierarchie zodat de chip-row consistent oogt over runs.
  const counts = useMemo(() => {
    const c: Record<Discipline, number> = {
      toneel: 0,
      dans: 0,
      cabaret: 0,
      opera: 0,
      familie: 0,
      overig: 0,
    };
    for (const s of shows) c[disciplineFor(s)] += 1;
    return c;
  }, [shows]);

  const visibleChips: Discipline[] = (['toneel', 'dans', 'cabaret', 'opera', 'familie', 'overig'] as Discipline[])
    .filter((d) => counts[d] > 0);

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT,
          paddingBottom: insets.bottom + 24,
        }}
      >
        {/* Discipline-chips bovenaan — sticky-look maar gewoon meeschuift.
            Eerste chip = "Alle" om snel naar de complete lijst terug. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
        >
          <Chip
            label={t('Alle', 'All')}
            count={shows.length}
            active={selected === 'all'}
            onPress={() => setSelected('all')}
          />
          {visibleChips.map((d) => (
            <Chip
              key={d}
              label={DISCIPLINE_LABELS[d][locale === 'en' ? 'en' : 'nl']}
              count={counts[d]}
              active={selected === d}
              onPress={() => setSelected(d)}
            />
          ))}
        </ScrollView>

        {isLoading && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Laden…', 'Loading…')}
            </Text>
          </View>
        )}
        {error && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Kon theater niet laden.', 'Couldn’t load theatre.')}
            </Text>
          </View>
        )}
        {filtered.length === 0 && !isLoading && !error && (
          <View style={styles.centerWrap}>
            <Text style={[styles.dim, { color: roles.fgMuted }]}>
              {t('Geen voorstellingen.', 'No shows.')}
            </Text>
          </View>
        )}
        {filtered.map((s) => (
          <ShowCard key={s.id} show={s} locale={locale} />
        ))}
      </ScrollView>

      <AppHeader
        title={t('Theater', 'Theatre')}
        hideAvatar
        rightSlot={
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
        }
      />
    </View>
  );
}

function Chip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? roles.accent : 'transparent',
          borderColor: active ? roles.accent : roles.bgChip,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          { color: active ? roles.onAccent : roles.fg },
        ]}
      >
        {label}
        <Text
          style={{ color: active ? roles.onAccent : roles.fgMuted }}
        >
          {' '}
          {count}
        </Text>
      </Text>
    </Pressable>
  );
}

function ShowCard({ show, locale }: { show: ApiEvent; locale: Locale }) {
  const roles = useRoles();
  const banner = eventImageUrl(show);
  const discipline = disciplineFor(show);

  // Verzamel unieke speeldata uit occurrencesInRange (max 8 tonen,
  // anders + N). Format "Wo 22 mei · 20:00".
  const dates = useMemo(() => {
    const occs = show.occurrencesInRange ?? [];
    // Vanaf vandaag-00:00 — backend kan een occurrence die gisteren
    // startte en vandaag eindigde nog teruggeven, maar voor de
    // discovery-lijst willen we alleen 'wat kan ik nog plannen'.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const minMs = startOfToday.getTime();
    const byDay = new Map<string, Date>();
    for (const o of occs) {
      if (isMultiDay(o.startsAt, o.endsAt)) continue;
      const d = new Date(o.startsAt);
      if (d.getTime() < minMs) continue;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
      if (!byDay.has(key)) byDay.set(key, d);
    }
    return [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
  }, [show]);

  const visibleDates = dates.slice(0, 5);
  const extra = dates.length - visibleDates.length;

  return (
    <Pressable
      onPress={() =>
        router.push(`/event/${show.id}?source=theater` as never)
      }
      style={styles.card}
    >
      <View
        style={[styles.banner, { backgroundColor: roles.bgLift }]}
      >
        {banner ? (
          <Image
            source={{ uri: banner }}
            style={styles.bannerImg}
            contentFit="cover"
          />
        ) : null}
        <View style={[styles.disciplineChip, { backgroundColor: roles.accent }]}>
          <Text style={[styles.disciplineText, { color: roles.onAccent }]}>
            {DISCIPLINE_LABELS[discipline][locale === 'en' ? 'en' : 'nl'].toLowerCase()}
          </Text>
        </View>
      </View>
      <View style={styles.body}>
        <Text
          style={[styles.venue, { color: roles.fgMuted }]}
          numberOfLines={1}
        >
          {show.venue.name}
        </Text>
        <Text style={[styles.title, { color: roles.fg }]} numberOfLines={2}>
          {show.title}
        </Text>
        {visibleDates.length > 0 && (
          <Text style={[styles.dates, { color: roles.fgRead }]}>
            {visibleDates
              .map((d) => {
                const dow = dowMixed(d.getDay(), locale);
                const day = d.getDate();
                const month = monthShort(d.getMonth(), locale).toLowerCase();
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                return `${dow} ${day} ${month} ${hh}:${mm}`;
              })
              .join(' · ')}
            {extra > 0 ? ` · +${extra}` : ''}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  chipsRow: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingTop: 4,
    paddingBottom: 16,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipText: {
    fontFamily: fontFamily.bold,
    fontSize: 13,
    letterSpacing: -0.13,
  },
  centerWrap: {
    paddingHorizontal: HORIZONTAL_PADDING,
    paddingVertical: 60,
    alignItems: 'center',
  },
  dim: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  card: {
    paddingHorizontal: HORIZONTAL_PADDING,
    marginBottom: 22,
  },
  banner: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
  },
  bannerImg: { width: '100%', height: '100%' },
  disciplineChip: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  disciplineText: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  body: { gap: 0 },
  venue: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: -0.12,
    marginBottom: 2,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.34,
    marginBottom: 1,
  },
  dates: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: -0.13,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
