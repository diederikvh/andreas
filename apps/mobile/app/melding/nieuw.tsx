import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FilterChip } from '@/components/FilterChip';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiTastePreview, ApiTasteSample } from '@/lib/api';
import { translateCategory } from '@/lib/eventDisplay';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import { useAlerts, useCreateTasteAlert, usePreviewTasteAlert, useUpdateTasteAlert } from '@/lib/queries';
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
 * Smaak in eigen woorden plus een grens (stad of soort). Eerst proeven: de
 * keurder op de server leest de laatste 25 kandidaten en zegt per event
 * waarom wel of niet. Pas daarna kun je opslaan.
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
const CATEGORIES = ['Muziek', 'Film', 'Theater', 'Kunst', 'Lezing', 'Literatuur'] as const;

const toggleIn = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

export default function NieuweMelding() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { data: alerts } = useAlerts({ enabled: Boolean(id) });
  const existing = id ? (alerts ?? []).find((a) => a.id === id) : undefined;
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const [taste, setTaste] = useState('');
  const [cities, setCities] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>(['Muziek']);
  const [preview, setPreview] = useState<ApiTastePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewM = usePreviewTasteAlert();
  const create = useCreateTasteAlert();
  const update = useUpdateTasteAlert();
  const saving = create.isPending || update.isPending;

  // Bewerken: één keer invullen met wat er staat zodra de melding er is.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    if (!existing || filled) return;
    setTaste(existing.taste ?? '');
    // `?? []`: een antwoord uit de cache van vóór deze velden heeft ze niet.
    setCities(existing.cities ?? []);
    setCategories(existing.categories ?? []);
    setFilled(true);
  }, [existing, filled]);

  const input = { taste: taste.trim(), cities, categories };
  const canTry = input.taste.length >= 3 && (cities.length > 0 || categories.length > 0);
  // Een proef hoort bij precies deze invoer; verander je iets, dan moet je
  // opnieuw proeven voordat je opslaat.
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
        contentContainerStyle={[
          styles.content,
          { paddingTop: 8, paddingBottom: insets.bottom + 40 },
        ]}
      >
        <Text style={[styles.label, { color: roles.fg }]}>
          {t('Waar wil je van horen?', 'What do you want to hear about?')}
        </Text>
        <TextInput
          value={taste}
          onChangeText={(v) => {
            setTaste(v);
            stale();
          }}
          placeholder={t(
            'Bijv. gitaarbands met een jaren-90-randje, zoals The Afghan Whigs',
            'E.g. guitar bands with a 90s edge, like The Afghan Whigs',
          )}
          placeholderTextColor={roles.fgPlaceholder}
          multiline
          // Bij bewerken niet meteen het toetsenbord: je komt kijken, en
          // past misschien alleen een stad aan.
          autoFocus={!id}
          // Bandnamen: "Afghan Whigs" werd "Afghaan Whigs", en daar zoekt de
          // keurder dan op.
          autoCorrect={false}
          style={[
            styles.input,
            {
              color: roles.fg,
              borderColor: isNacht ? '#2a2a2d' : palette.paper,
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
            },
          ]}
        />

        <Text style={[styles.label, { color: roles.fg }]}>{t('Waar', 'Where')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chips}
        >
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
        </ScrollView>

        <Text style={[styles.label, { color: roles.fg }]}>{t('Wat', 'What')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chips}
        >
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
        </ScrollView>
        {cities.length === 0 && categories.length === 0 ? (
          <Text style={[styles.hint, { color: roles.fgMuted }]}>
            {t('Kies een stad of een soort, anders wordt het een stroom.', 'Pick a city or a kind, or it turns into a flood.')}
          </Text>
        ) : null}

        {/* Eén knop over de hele breedte: eerst proeven, dan opslaan. Weg
            zonder opslaan gaat met het kruisje. */}
        {preview ? (
          <Pressable
            onPress={save}
            disabled={saving}
            style={[styles.bigBtn, { backgroundColor: roles.accent }]}
          >
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

        {/* De uitkomst onder de knop: je tikt, en leest verder naar beneden. */}
        {previewM.isPending ? (
          <View style={styles.waiting}>
            <SpinningCross size={20} color={roles.fgMuted} />
            <Text style={[styles.hint, { color: roles.fgMuted }]}>
              {t('Ik kijk wat er recent binnenkwam…', 'Checking what came in recently…')}
            </Text>
          </View>
        ) : null}

        {preview ? <PreviewResult preview={preview} /> : null}

        {error ? <Text style={[styles.hint, { color: roles.fg }]}>{error}</Text> : null}

      </ScrollView>

    </View>
  );
}

function PreviewResult({ preview }: { preview: ApiTastePreview }) {
  const roles = useRoles();
  const t = useT();
  const line = (x: ApiTasteSample, yes: boolean) => (
    <Pressable
      key={x.id}
      onPress={() => router.push(`/event/${x.id}?source=other` as never)}
      style={styles.hit}
    >
      <Text style={[styles.hitTitle, { color: yes ? roles.fg : roles.fgMuted }]}>{x.title}</Text>
      <Text style={[styles.hitText, { color: roles.fgMuted }]}>
        {x.venue} — {x.reason}
      </Text>
    </Pressable>
  );
  const n = preview.yes.length;
  return (
    <View style={styles.preview}>
      {/* Wat je ziet is een proef: hoe Andreas je omschrijving leest, op
          de events die het laatst binnenkwamen. Eerst wat je gemeld had
          gekregen, dan een paar die niet pasten en waarom. */}
      <Text style={[styles.previewIntro, { color: roles.fgMuted }]}>
        {t(
          `Zo leest Andreas je omschrijving. Ik heb de laatste ${preview.sampled} nieuwe events erop bekeken.`,
          `This is how Andreas reads your description. I checked the latest ${preview.sampled} new events against it.`,
        )}
      </Text>

      <Text style={[styles.previewHead, { color: roles.fg }]}>
        {n === 0
          ? t('Daarvan had je er geen gemeld gekregen.', 'None of them would have been sent to you.')
          : n === 1
            ? t('Hierover had je een melding gekregen:', 'You would have been alerted about this one:')
            : t(`Hierover had je een melding gekregen (${n}):`, `You would have been alerted about these (${n}):`)}
      </Text>
      {n === 0 ? (
        <Text style={[styles.hint, { color: roles.fgMuted }]}>
          {t(
            'Dat kan kloppen: de melding gaat over wat er vanaf nu bijkomt, en in die laatste events zat misschien gewoon niets voor jou.',
            'That can be fine: the alert is about what comes in from now on, and there may simply have been nothing for you among these.',
          )}
        </Text>
      ) : (
        preview.yes.map((x) => line(x, true))
      )}

      {preview.no.length > 0 ? (
        <>
          <Text style={[styles.previewSub, { color: roles.fg }]}>
            {t('Een paar die niet pasten, en waarom:', 'A few that did not fit, and why:')}
          </Text>
          {preview.no.slice(0, 3).map((x) => line(x, false))}
        </>
      ) : null}

      <Text style={[styles.hint, { color: roles.fgMuted }]}>
        {t(
          'Klopt dit niet met wat je bedoelt? Maak je omschrijving specifieker, bijvoorbeeld met een artiest als voorbeeld, en probeer opnieuw.',
          'Not what you meant? Make your description more specific, for example by naming an artist, and try again.',
        )}
      </Text>
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
  label: { fontFamily: fontFamily.bold, fontSize: 14, marginTop: 4 },
  input: {
    fontFamily: fontFamily.medium,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 76,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: 'top',
  },
  // De chip-rijen lopen tot de rand door: negatieve marge tegen de
  // padding van de pagina, zodat je ze onder de duim wegveegt.
  chipScroll: { marginHorizontal: -22 },
  chips: { gap: 6, paddingHorizontal: 22 },
  hint: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 10 },
  preview: { gap: 10, paddingTop: 10 },
  previewIntro: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
  previewHead: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 22 },
  previewSub: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 22, paddingTop: 8 },
  hit: { gap: 2, paddingVertical: 2 },
  hitTitle: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 20 },
  hitText: { fontFamily: fontFamily.body, fontSize: 14.5, lineHeight: 20 },
  bigBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 8, marginTop: 10 },
  bigLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
});
