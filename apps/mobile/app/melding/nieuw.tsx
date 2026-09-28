import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterChip } from '@/components/FilterChip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiGenreOption, ApiRulePreview, RuleAlertInput } from '@/lib/api';
import { translateCategory } from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  useAlerts,
  useCreateRuleAlert,
  useGenreOptions,
  usePreviewRuleAlert,
  useUpdateRuleAlert,
} from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Nieuwe melding, als eigen scherm dat als pop-up opent. Met `?id=` is het
 * hetzelfde formulier om een bestaande melding te bewerken.
 *
 * Geen "Annuleren"-knop: het kruisje rechtsboven sluit dit scherm en brengt
 * je terug naar je lijst. Eén manier om weg te gaan, zodat het kruisje
 * nooit iets anders betekent dan "niet opslaan".
 *
 * Een regel bouw je uit vaste velden: soort, genres, artiesten,
 * trefwoorden en stad. Geen model aan onze kant. Terwijl je bouwt staat
 * er in één zin hoe Andreas de regel leest, zodat je ziet waar hij op let.
 * Smaak in eigen woorden ("zoals The Afghan Whigs") gaat via je eigen AI
 * (MCP): die vertaalt het naar dezelfde velden.
 */

const CITIES: { key: string; label: string }[] = [
  { key: 'amsterdam', label: 'Amsterdam' },
  { key: 'utrecht', label: 'Utrecht' },
  { key: 'rotterdam', label: 'Rotterdam' },
  { key: 'den-haag', label: 'Den Haag' },
  { key: 'haarlem', label: 'Haarlem' },
  { key: 'eindhoven', label: 'Eindhoven' },
  { key: 'tilburg', label: 'Tilburg' },
  { key: 'nijmegen', label: 'Nijmegen' },
  { key: 'groningen', label: 'Groningen' },
  { key: 'antwerpen', label: 'Antwerpen' },
];
const CATEGORIES = ['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur', 'Activiteit'] as const;

const toggleIn = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

/** "Pixies, Dinosaur Jr." → ["Pixies", "Dinosaur Jr."] */
const splitList = (v: string) =>
  [...new Set(v.split(/[,\n]/).map((x) => x.trim()).filter((x) => x.length >= 2))];

export default function NieuweMelding() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data: alerts } = useAlerts({ enabled: Boolean(id) });
  const existing = id ? (alerts ?? []).find((a) => a.id === id) : undefined;
  const { data: genreOptions } = useGenreOptions();
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const [categories, setCategories] = useState<string[]>(['Muziek']);
  const [genres, setGenres] = useState<string[]>([]);
  const [artistsText, setArtistsText] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [preview, setPreview] = useState<ApiRulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewM = usePreviewRuleAlert();
  const create = useCreateRuleAlert();
  const update = useUpdateRuleAlert();
  const saving = create.isPending || update.isPending;

  // Bewerken: één keer invullen met wat er staat zodra de melding er is.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!existing || filled) return;
    // `?? []`: een antwoord uit de cache van vóór deze velden heeft ze niet.
    setCategories(existing.categories ?? []);
    setGenres(existing.genres ?? []);
    setArtistsText((existing.artists ?? []).join(', '));
    setKeywordsText((existing.keywords ?? []).join(', '));
    setCities(existing.cities ?? []);
    setFilled(true);
  }, [existing, filled]);

  const input: RuleAlertInput = {
    cities,
    categories,
    genres,
    artists: splitList(artistsText),
    keywords: splitList(keywordsText),
  };
  const canTry = input.genres.length > 0 || input.artists.length > 0 || input.keywords.length > 0;
  // Een proef hoort bij precies deze invoer; verander je iets, dan moet je
  // opnieuw proberen voordat je opslaat.
  const stale = () => {
    setPreview(null);
    setError(null);
  };
  const tryIt = () => {
    softTap();
    setError(null);
    previewM.mutate(input, {
      onSuccess: setPreview,
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  };
  const save = () => {
    softTap();
    const done = {
      onSuccess: () => router.back(),
      onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    };
    if (id) update.mutate({ id, input }, done);
    else create.mutate(input, done);
  };

  // Genres van de gekozen soorten; zonder soort alles.
  const shownGenres = (genreOptions ?? []).filter(
    (g) => categories.length === 0 || g.categories.some((c) => categories.includes(c)),
  );
  const inputStyle = [
    styles.input,
    {
      color: roles.fg,
      borderColor: isNacht ? '#2a2a2d' : palette.paper,
      backgroundColor: isNacht ? palette.noir2 : palette.paper2,
    },
  ];

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {/* Een formulier krijgt een gewone titel, geen logo-header. iOS toont
          een modal als sheet die al onder de statusbalk begint, dus daar
          geen safe area; Android toont 'm schermvullend. */}
      <View style={[styles.topBar, { paddingTop: Platform.OS === 'ios' ? 18 : insets.top + 10 }]}>
        <Text style={[styles.title, { color: roles.fg }]}>
          {id ? t('Melding bewerken', 'Edit alert') : t('Nieuwe melding', 'New alert')}
        </Text>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={[styles.closeBtn, { backgroundColor: isNacht ? palette.noir2 : palette.paper2 }]}
          accessibilityLabel={t('Sluiten', 'Close')}
        >
          <Ionicons name="close" size={20} color={roles.fg} />
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[styles.content, { paddingTop: 8, paddingBottom: insets.bottom + 40 }]}
      >
        <Text style={[styles.hint, { color: roles.fgMuted }]}>
          {t(
            'Je krijgt om 10:00 bericht als er iets nieuws bijkomt met een van je artiesten, of met een van je genres. Vul je een trefwoord in, dan moet dat woord ook in de aankondiging staan.',
            'You get a message at 10:00 when something new comes in with one of your artists, or with one of your genres. Add a keyword and that word must also appear in the announcement.',
          )}
        </Text>

        {existing?.legacy ? (
          <Text style={[styles.hint, { color: roles.fg }]}>
            {t(
              `Dit was een melding in eigen woorden: "${existing.taste}". Die doet niets meer. Bouw hem hieronder opnieuw op, of vraag het je eigen AI.`,
              `This was an alert in your own words: "${existing.taste}". It no longer does anything. Rebuild it below, or ask your own AI.`,
            )}
          </Text>
        ) : null}

        <Text style={[styles.label, { color: roles.fg }]}>{t('Wat', 'What')}</Text>
        <ChipRow>
          {CATEGORIES.map((c) => (
            <FilterChip
              key={c}
              label={translateCategory(c, locale)}
              active={categories.includes(c)}
              onPress={() => {
                softTap();
                setCategories((l) => toggleIn(l, c));
                stale();
              }}
            />
          ))}
        </ChipRow>

        <Text style={[styles.label, { color: roles.fg }]}>{t('Genres', 'Genres')}</Text>
        {genreOptions ? (
          <View style={styles.wrap}>
            {shownGenres.map((g: ApiGenreOption) => (
              <FilterChip
                key={g.key}
                label={g.label}
                active={genres.includes(g.key)}
                onPress={() => {
                  softTap();
                  setGenres((l) => toggleIn(l, g.key));
                  stale();
                }}
              />
            ))}
          </View>
        ) : (
          <SpinningCross size={18} color={roles.fgMuted} />
        )}

        <Text style={[styles.label, { color: roles.fg }]}>{t('Artiesten', 'Artists')}</Text>
        <TextInput
          value={artistsText}
          onChangeText={(v) => {
            setArtistsText(v);
            stale();
          }}
          placeholder={t('Bijv. The Afghan Whigs, Pixies', 'E.g. The Afghan Whigs, Pixies')}
          placeholderTextColor={roles.fgPlaceholder}
          // Bandnamen: "Afghan Whigs" werd "Afghaan Whigs".
          autoCorrect={false}
          style={inputStyle}
        />

        <Text style={[styles.label, { color: roles.fg }]}>{t('Trefwoorden', 'Keywords')}</Text>
        <TextInput
          value={keywordsText}
          onChangeText={(v) => {
            setKeywordsText(v);
            stale();
          }}
          placeholder={t('Bijv. 90s, grunge', 'E.g. 90s, grunge')}
          placeholderTextColor={roles.fgPlaceholder}
          autoCorrect={false}
          autoCapitalize="none"
          style={inputStyle}
        />

        <Text style={[styles.label, { color: roles.fg }]}>{t('Waar', 'Where')}</Text>
        <ChipRow>
          <FilterChip
            label={t('Overal', 'Anywhere')}
            active={cities.length === 0}
            onPress={() => {
              softTap();
              setCities([]);
              stale();
            }}
          />
          {CITIES.map((c) => (
            <FilterChip
              key={c.key}
              label={c.label}
              active={cities.includes(c.key)}
              onPress={() => {
                softTap();
                setCities((l) => toggleIn(l, c.key));
                stale();
              }}
            />
          ))}
        </ChipRow>

        {/* Hoe Andreas de regel leest, terwijl je bouwt. */}
        <View style={[styles.reading, { backgroundColor: roles.bgChip }]}>
          <Text style={[styles.readingHead, { color: roles.fgMuted }]}>
            {t('Zo lees ik je melding', 'How I read your alert')}
          </Text>
          <Text style={[styles.readingText, { color: roles.fg }]}>
            {canTry
              ? readRule(input, genreOptions ?? [], locale, t)
              : t(
                  'Kies een genre, vul een artiest of een trefwoord in.',
                  'Pick a genre, or add an artist or a keyword.',
                )}
          </Text>
        </View>

        {/* Eén knop over de hele breedte: eerst proberen, dan opslaan. Weg
            zonder opslaan gaat met het kruisje. */}
        {preview ? (
          <Pressable onPress={save} disabled={saving} style={[styles.bigBtn, { backgroundColor: roles.accent }]}>
            <Text style={[styles.bigLabel, { color: roles.onAccent }]}>
              {saving ? t('Bezig…', 'Saving…') : t('Opslaan', 'Save')}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={tryIt}
            disabled={!canTry || previewM.isPending}
            style={[styles.bigBtn, { backgroundColor: roles.accent, opacity: canTry ? 1 : 0.4 }]}
          >
            <Text style={[styles.bigLabel, { color: roles.onAccent }]}>{t('Probeer', 'Try it')}</Text>
          </Pressable>
        )}

        {previewM.isPending ? (
          <View style={styles.waiting}>
            <SpinningCross size={20} color={roles.fgMuted} />
          </View>
        ) : null}
        {preview ? <PreviewResult preview={preview} /> : null}
        {error ? <Text style={[styles.hint, { color: roles.fg }]}>{error}</Text> : null}

        <AiNote />
      </ScrollView>
    </View>
  );
}

/** Een rij chips die tot de rand doorloopt, onder de duim weg te vegen. */
function ChipRow({ children }: { children: ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.chipScroll}
      contentContainerStyle={styles.chips}
    >
      {children}
    </ScrollView>
  );
}

/** "Nieuwe muziek met rock of indie én "90s" in de aankondiging, of met
    Pixies. In Amsterdam." — dezelfde logica als de server (ALERT_MATCH). */
function readRule(
  i: RuleAlertInput,
  options: ApiGenreOption[],
  locale: string,
  t: (nl: string, en: string) => string,
): string {
  const or = t(' of ', ' or ');
  const quote = (xs: string[]) => xs.map((x) => `"${x}"`).join(or);
  const labelOf = (k: string) => options.find((o) => o.key === k)?.label ?? k;
  const what = i.categories.length
    ? i.categories.map((c) => translateCategory(c as (typeof CATEGORIES)[number], locale as 'nl' | 'en').toLowerCase()).join(or)
    : t('alles', 'anything');
  const parts: string[] = [];
  if (i.genres.length && i.keywords.length) {
    parts.push(
      t(
        `met ${i.genres.map(labelOf).join(or)} én ${quote(i.keywords)} in de aankondiging`,
        `with ${i.genres.map(labelOf).join(or)} and ${quote(i.keywords)} in the announcement`,
      ),
    );
  } else if (i.genres.length) {
    parts.push(t(`met ${i.genres.map(labelOf).join(or)}`, `with ${i.genres.map(labelOf).join(or)}`));
  } else if (i.keywords.length) {
    parts.push(t(`met ${quote(i.keywords)} in de aankondiging`, `with ${quote(i.keywords)} in the announcement`));
  }
  if (i.artists.length) {
    parts.push(t(`met ${i.artists.join(', ')}`, `with ${i.artists.join(', ')}`));
  }
  const where = i.cities.length
    ? t(
        ` In ${i.cities.map((c) => CITIES.find((x) => x.key === c)?.label ?? c).join(or)}.`,
        ` In ${i.cities.map((c) => CITIES.find((x) => x.key === c)?.label ?? c).join(or)}.`,
      )
    : t(' Overal.', ' Anywhere.');
  return t(`Nieuw aanbod in ${what} ${parts.join(', of ')}.`, `New ${what} ${parts.join(', or ')}.`) + where;
}

function PreviewResult({ preview }: { preview: ApiRulePreview }) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();
  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString(locale === 'en' ? 'en-GB' : 'nl-NL', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  return (
    <View style={styles.preview}>
      <Text style={[styles.previewHead, { color: roles.fg }]}>
        {preview.total === 0
          ? t('Er staat nu niets dat past.', 'Nothing fits right now.')
          : t(`Nu al passend: ${preview.total}`, `Already fitting: ${preview.total}`)}
      </Text>
      <Text style={[styles.hint, { color: roles.fgMuted }]}>
        {preview.total === 0
          ? t(
              'Prima: je hoort het zodra er iets bijkomt. Blijft het stil, maak de regel dan ruimer.',
              "Fine: you'll hear as soon as something comes in. If it stays quiet, make the rule broader.",
            )
          : t(
              'Hierover krijg je geen bericht; alleen over wat er vanaf nu bijkomt. Zo zie je of je regel te ruim of te krap is.',
              "You won't get a message about these; only about what comes in from now on. This shows whether your rule is too broad or too narrow.",
            )}
      </Text>
      {preview.events.map((x) => (
        <Pressable
          key={x.id}
          onPress={() => router.push(`/event/${x.id}?source=other` as never)}
          style={styles.hit}
        >
          <Text style={[styles.hitTitle, { color: roles.fg }]}>{x.title}</Text>
          <Text style={[styles.hitText, { color: roles.fgMuted }]}>
            {x.venue} · {fmt(x.startsAt)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Voor wie het in eigen woorden wil: via de eigen AI (MCP). */
function AiNote() {
  const roles = useRoles();
  const t = useT();
  return (
    <View style={styles.aiNote}>
      <Text style={[styles.hint, { color: roles.fgMuted }]}>
        {t(
          'Liever in eigen woorden? Zeg tegen je eigen AI, zoals Claude of ChatGPT: "Seintje bij gitaarbands met een jaren-90-randje, zoals The Afghan Whigs." Die zet het om naar genres, verwante artiesten en trefwoorden, en kan ook zalen kiezen.',
          'Rather use your own words? Tell your own AI, like Claude or ChatGPT: "Alert me to guitar bands with a 90s edge, like The Afghan Whigs." It turns that into genres, related artists and keywords, and can pick venues too.',
        )}
      </Text>
      <Pressable
        onPress={() => {
          softTap();
          void Linking.openURL('https://andreas.amsterdam/ai');
        }}
        hitSlop={10}
      >
        <Text style={[styles.link, { color: roles.fg }]}>{t('Zo koppel je Andreas →', 'How to connect Andreas →')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 22, gap: 10 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  title: { fontFamily: fontFamily.display, fontSize: 24, letterSpacing: -0.5 },
  closeBtn: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: fontFamily.bold, fontSize: 14, marginTop: 8 },
  input: {
    fontFamily: fontFamily.medium,
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // De chip-rijen lopen tot de rand door: negatieve marge tegen de
  // padding van de pagina, zodat je ze onder de duim wegveegt.
  chipScroll: { marginHorizontal: -22 },
  chips: { gap: 6, paddingHorizontal: 22 },
  // Genres zijn er te veel voor één veegrij: die lopen door naar onder.
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  hint: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
  reading: { borderRadius: 12, padding: 14, gap: 4, marginTop: 10 },
  readingHead: { fontFamily: fontFamily.bold, fontSize: 12, letterSpacing: 0.4, textTransform: 'uppercase' },
  readingText: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 21 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 },
  preview: { gap: 10, paddingTop: 10 },
  previewHead: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 22 },
  hit: { gap: 2, paddingVertical: 2 },
  hitTitle: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 20 },
  hitText: { fontFamily: fontFamily.body, fontSize: 14.5, lineHeight: 20 },
  bigBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 8, marginTop: 10 },
  bigLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
  aiNote: { gap: 8, paddingTop: 24 },
  link: { fontFamily: fontFamily.bold, fontSize: 14 },
});
