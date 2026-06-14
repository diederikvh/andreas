/**
 * Aanbevolen-onboarding (en setting). Drie stappen:
 *   1. Scenes — multi-select (Dansen / Concerten / Klassiek & jazz /
 *      Theater / Film / Kunst & musea / Lezingen & boeken)
 *   2. Smaak  — single-select (Mainstream / Alternatief / Niche)
 *   3. Preview — bevestiging met selected + maybe sets, in/uit-toggleable
 *
 * Twee entry-modes:
 *   - Onboarding: leeg-feed-state, geen exit-knop op stap 1, slide weg
 *     na commit en de feed laadt.
 *   - Settings: open vanuit topbar-icoon op /voor-jou. Idem flow maar
 *     bestaande follows worden niet aangeraakt — alleen additief.
 *
 * Geen state-persistentie tussen sessies: elke open is een schone slate.
 * Bestaande follows worden in de suggesties-query gefilterd zodat we
 * niet 2× hetzelfde aanbieden.
 */
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useT, useLocale, type Locale } from '@/lib/i18n';
import type {
  AanbevolenScene,
  AanbevolenFlavor,
  BootstrapVenue,
} from '@/lib/api';
import {
  useBootstrapSuggestions,
  useBulkFollowVenues,
} from '@/lib/queries';
import { useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

type SceneIcon =
  | { lib: 'io'; name: keyof typeof Ionicons.glyphMap }
  | { lib: 'mci'; name: keyof typeof MaterialCommunityIcons.glyphMap };

const SCENES: Array<{
  id: AanbevolenScene;
  icon: SceneIcon;
  nl: string;
  en: string;
}> = [
  { id: 'dansen', icon: { lib: 'io', name: 'disc-outline' }, nl: 'Dansen', en: 'Dancing' },
  { id: 'concerten', icon: { lib: 'io', name: 'musical-notes-outline' }, nl: 'Concerten', en: 'Concerts' },
  { id: 'klassiek_jazz', icon: { lib: 'io', name: 'musical-note-outline' }, nl: 'Klassiek & jazz', en: 'Classical & jazz' },
  { id: 'theater', icon: { lib: 'mci', name: 'drama-masks' }, nl: 'Theater', en: 'Theatre' },
  { id: 'film', icon: { lib: 'io', name: 'film-outline' }, nl: 'Film', en: 'Film' },
  { id: 'kunst', icon: { lib: 'io', name: 'color-palette-outline' }, nl: 'Kunst & musea', en: 'Art & museums' },
  { id: 'lezingen', icon: { lib: 'io', name: 'library-outline' }, nl: 'Lezingen & boeken', en: 'Talks & books' },
];

const FLAVORS: Array<{
  id: AanbevolenFlavor;
  nl: { label: string; sub: string };
  en: { label: string; sub: string };
}> = [
  {
    id: 'mainstream',
    nl: { label: 'Mainstream', sub: 'Bekende namen, grote zalen' },
    en: { label: 'Mainstream', sub: 'Known names, bigger rooms' },
  },
  {
    id: 'alternatief',
    nl: { label: 'Alternatief', sub: 'Eigen pad, iets minder beladen' },
    en: { label: 'Alternative', sub: 'Own path, off-mainstream' },
  },
  {
    id: 'niche',
    nl: { label: 'Niche', sub: 'Diep in de scene, kleine spots' },
    en: { label: 'Niche', sub: 'Deep in the scene, small spots' },
  },
];

type Step = 'scenes' | 'flavor' | 'preview' | 'committing';

export function AanbevolenPicker({
  mode,
  onClose,
  onDone,
}: {
  mode: 'onboarding' | 'settings';
  onClose: () => void;
  onDone: () => void;
}) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();

  const [step, setStep] = useState<Step>('scenes');
  const [scenes, setScenes] = useState<Set<AanbevolenScene>>(new Set());
  const [flavor, setFlavor] = useState<AanbevolenFlavor | null>(null);
  // venue-ids die we gaan volgen — start gevuld met `selected` zodra
  // de preview-query terugkomt, plus alles wat user in `maybe` aanvinkt.
  const [chosen, setChosen] = useState<Set<string>>(new Set());

  const suggestionsQuery = useBootstrapSuggestions({
    scenes: [...scenes],
    flavor,
    enabled: step === 'preview',
  });
  const bulkFollow = useBulkFollowVenues();

  // Wanneer suggesties binnenkomen, pre-vink alle "selected" venues aan.
  // "Maybe" blijft default uitgevinkt — user moet expliciet aanzetten.
  useEffect(() => {
    if (suggestionsQuery.data) {
      setChosen(new Set(suggestionsQuery.data.selected.map((v) => v.id)));
    }
  }, [suggestionsQuery.data]);

  const toggleScene = (s: AanbevolenScene) =>
    setScenes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggleVenue = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const commit = async () => {
    setStep('committing');
    try {
      await bulkFollow.mutateAsync([...chosen]);
      onDone();
    } catch {
      setStep('preview');
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <View style={styles.headerBar}>
        <Text style={[styles.headerTitle, { color: roles.fg }]}>
          {t('Aanbevolen', 'Recommended')}
        </Text>
        {/* In onboarding-mode bieden we wel een sluit-knop (skip) — anders
            kun je geen feed bekijken zonder iets te doen. */}
        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
          <Ionicons name="close" size={20} color={roles.fg} />
        </Pressable>
      </View>

      {step === 'scenes' && (
        <StepScenes
          scenes={scenes}
          locale={locale}
          t={t}
          onToggle={toggleScene}
          onNext={() => setStep('flavor')}
        />
      )}
      {step === 'flavor' && (
        <StepFlavor
          flavor={flavor}
          locale={locale}
          t={t}
          onPick={setFlavor}
          onBack={() => setStep('scenes')}
          onNext={() => setStep('preview')}
        />
      )}
      {(step === 'preview' || step === 'committing') && (
        <StepPreview
          mode={mode}
          loading={suggestionsQuery.isLoading || step === 'committing'}
          error={suggestionsQuery.error ? true : false}
          data={suggestionsQuery.data ?? null}
          chosen={chosen}
          onToggleVenue={toggleVenue}
          onBack={() => setStep('flavor')}
          onCommit={commit}
          t={t}
        />
      )}
    </View>
  );
}

function StepScenes({
  scenes,
  locale,
  t,
  onToggle,
  onNext,
}: {
  scenes: Set<AanbevolenScene>;
  locale: Locale;
  t: ReturnType<typeof useT>;
  onToggle: (s: AanbevolenScene) => void;
  onNext: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={styles.scrollPad}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.kicker, { color: roles.accent }]}>
          {t('Stap 1 van 3', 'Step 1 of 3')}
        </Text>
        <Text style={[styles.title, { color: roles.fg }]}>
          {t('Wat is je scene?', "What's your scene?")}
        </Text>
        <Text style={[styles.lead, { color: roles.fgMuted }]}>
          {t(
            'Kies één of meer. Niet definitief — je kan dit later aanpassen.',
            'Pick one or more. Not final — you can adjust this later.',
          )}
        </Text>
        <View style={styles.grid}>
          {SCENES.map((s) => (
            <SceneTile
              key={s.id}
              icon={s.icon}
              label={locale === 'en' ? s.en : s.nl}
              active={scenes.has(s.id)}
              onPress={() => onToggle(s.id)}
            />
          ))}
        </View>
      </ScrollView>
      <BottomCta
        label={t('Volgende', 'Next')}
        enabled={scenes.size > 0}
        onPress={onNext}
      />
    </View>
  );
}

function StepFlavor({
  flavor,
  locale,
  t,
  onPick,
  onBack,
  onNext,
}: {
  flavor: AanbevolenFlavor | null;
  locale: Locale;
  t: ReturnType<typeof useT>;
  onPick: (f: AanbevolenFlavor) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={styles.scrollPad}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.kicker, { color: roles.accent }]}>
          {t('Stap 2 van 3', 'Step 2 of 3')}
        </Text>
        <Text style={[styles.title, { color: roles.fg }]}>
          {t('En wat is je smaak?', 'And what’s your taste?')}
        </Text>
        <Text style={[styles.lead, { color: roles.fgMuted }]}>
          {t(
            'Hiermee filteren we de venues. Eén keuze — voor nu.',
            'We use this to filter venues. One choice — for now.',
          )}
        </Text>
        <View style={{ marginTop: 8, gap: 10 }}>
          {FLAVORS.map((f) => {
            const text = locale === 'en' ? f.en : f.nl;
            const active = flavor === f.id;
            return (
              <Pressable
                key={f.id}
                onPress={() => onPick(f.id)}
                style={[
                  styles.flavorRow,
                  {
                    backgroundColor: active ? roles.accent : roles.bgLift,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.flavorLabel,
                    { color: active ? roles.onAccent : roles.fg },
                  ]}
                >
                  {text.label}
                </Text>
                <Text
                  style={[
                    styles.flavorSub,
                    {
                      color: active ? roles.onAccent : roles.fgMuted,
                      opacity: active ? 0.85 : 1,
                    },
                  ]}
                >
                  {text.sub}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <View style={styles.dualCtaWrap}>
        <Pressable
          onPress={onBack}
          style={[styles.secondaryCta, { backgroundColor: roles.bgLift }]}
        >
          <Text style={[styles.secondaryCtaLabel, { color: roles.fg }]}>
            {t('Terug', 'Back')}
          </Text>
        </Pressable>
        <Pressable
          disabled={!flavor}
          onPress={onNext}
          style={[
            styles.primaryCta,
            {
              backgroundColor: flavor ? roles.accent : roles.bgChip,
              opacity: flavor ? 1 : 0.6,
            },
          ]}
        >
          <Text style={[styles.primaryCtaLabel, { color: roles.onAccent }]}>
            {t('Volgende', 'Next')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function StepPreview({
  mode,
  loading,
  error,
  data,
  chosen,
  onToggleVenue,
  onBack,
  onCommit,
  t,
}: {
  mode: 'onboarding' | 'settings';
  loading: boolean;
  error: boolean;
  data: { selected: BootstrapVenue[]; maybe: BootstrapVenue[] } | null;
  chosen: Set<string>;
  onToggleVenue: (id: string) => void;
  onBack: () => void;
  onCommit: () => void;
  t: ReturnType<typeof useT>;
}) {
  const roles = useRoles();
  const chosenCount = chosen.size;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={styles.scrollPad}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.kicker, { color: roles.accent }]}>
          {t('Stap 3 van 3', 'Step 3 of 3')}
        </Text>
        <Text style={[styles.title, { color: roles.fg }]}>
          {t('Klopt dit?', 'Look right?')}
        </Text>
        <Text style={[styles.lead, { color: roles.fgMuted }]}>
          {mode === 'settings'
            ? t(
                'Bestaande follows blijven staan. Tap om aan/uit te zetten — daarna voegen we ze toe.',
                'Existing follows stay. Tap to toggle — then we add them.',
              )
            : t(
                'Tap een venue om aan/uit te zetten. Niet alle goed? Sla over en kies later in /venues.',
                'Tap a venue to toggle. Not quite right? Skip and pick later in /venues.',
              )}
        </Text>

        {loading && (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator color={roles.fgMuted} />
          </View>
        )}
        {error && (
          <Text style={[styles.errorText, { color: '#c9453a' }]}>
            {t('Kon suggesties niet laden.', 'Couldn’t load suggestions.')}
          </Text>
        )}
        {data && !loading && (
          <>
            {data.selected.length > 0 && (
              <View style={{ marginTop: 18 }}>
                <Text style={[styles.sectionLabel, { color: roles.fgMuted }]}>
                  {t('Volgen we voor je', 'We follow these for you')}
                </Text>
                <View style={styles.venueList}>
                  {data.selected.map((v) => (
                    <VenueTile
                      key={v.id}
                      venue={v}
                      active={chosen.has(v.id)}
                      onPress={() => onToggleVenue(v.id)}
                    />
                  ))}
                </View>
              </View>
            )}
            {data.maybe.length > 0 && (
              <View style={{ marginTop: 22 }}>
                <Text style={[styles.sectionLabel, { color: roles.fgMuted }]}>
                  {t('Misschien ook iets', 'Maybe also for you')}
                </Text>
                <View style={styles.venueList}>
                  {data.maybe.map((v) => (
                    <VenueTile
                      key={v.id}
                      venue={v}
                      active={chosen.has(v.id)}
                      onPress={() => onToggleVenue(v.id)}
                    />
                  ))}
                </View>
              </View>
            )}
            {data.selected.length === 0 && data.maybe.length === 0 && (
              <Text style={[styles.errorText, { color: roles.fgMuted }]}>
                {t(
                  'Geen matches gevonden — probeer andere keuzes.',
                  'No matches — try other picks.',
                )}
              </Text>
            )}
            {mode === 'settings' && (
              <Text style={[styles.tipFooter, { color: roles.fgMuted }]}>
                {t(
                  'Tip: in de Venues-tab kun je per venue stoppen met volgen.',
                  'Tip: in the Venues tab you can unfollow per venue.',
                )}
              </Text>
            )}
          </>
        )}
      </ScrollView>
      <View style={styles.dualCtaWrap}>
        <Pressable
          onPress={onBack}
          style={[styles.secondaryCta, { backgroundColor: roles.bgLift }]}
        >
          <Text style={[styles.secondaryCtaLabel, { color: roles.fg }]}>
            {t('Terug', 'Back')}
          </Text>
        </Pressable>
        <Pressable
          disabled={chosenCount === 0 || loading}
          onPress={onCommit}
          style={[
            styles.primaryCta,
            {
              backgroundColor:
                chosenCount > 0 && !loading ? roles.accent : roles.bgChip,
              opacity: chosenCount > 0 && !loading ? 1 : 0.6,
            },
          ]}
        >
          <Text style={[styles.primaryCtaLabel, { color: roles.onAccent }]}>
            {chosenCount > 0
              ? t(
                  `Volg deze ${chosenCount}`,
                  `Follow these ${chosenCount}`,
                )
              : t('Geen geselecteerd', 'Nothing selected')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function SceneTile({
  icon,
  label,
  active,
  onPress,
}: {
  icon: SceneIcon;
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  // Icon altijd in accent-kleur, achtergrond zacht (bgLift default,
  // accent-tint bij actief — matched aan de VenueTile-stijl en aan de
  // homepage shortcut-banners die ook accent-kleurige outline-iconen
  // op een neutrale tile gebruiken).
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.sceneTile,
        {
          backgroundColor: active ? `${roles.accent}26` : roles.bgLift,
          borderColor: active ? roles.accent : 'transparent',
        },
      ]}
    >
      {icon.lib === 'io' ? (
        <Ionicons name={icon.name} size={30} color={roles.accent} />
      ) : (
        <MaterialCommunityIcons name={icon.name} size={30} color={roles.accent} />
      )}
      <Text numberOfLines={2} style={[styles.sceneLabel, { color: roles.fg }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function VenueTile({
  venue,
  active,
  onPress,
}: {
  venue: BootstrapVenue;
  active: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.venueTile,
        {
          // Actief: zachte accent-tint (alpha ~15%) met harde accent-
          // border. Zo blijft de primaire CTA "Volg deze X" de enige
          // 100%-accent in beeld, terwijl actieve tiles wel onmiskenbaar
          // gemarkeerd zijn.
          backgroundColor: active ? `${roles.accent}26` : roles.bgLift,
          borderColor: active ? roles.accent : 'transparent',
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[styles.venueName, { color: roles.fg }]}
      >
        {venue.name}
      </Text>
      <Ionicons
        name={active ? 'checkmark-circle' : 'ellipse-outline'}
        size={18}
        color={active ? roles.accent : roles.fgMuted}
      />
    </Pressable>
  );
}

function BottomCta({
  label,
  enabled,
  onPress,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
}) {
  const roles = useRoles();
  return (
    <View style={styles.singleCtaWrap}>
      <Pressable
        disabled={!enabled}
        onPress={onPress}
        style={[
          styles.primaryCta,
          {
            backgroundColor: enabled ? roles.accent : roles.bgChip,
            opacity: enabled ? 1 : 0.6,
          },
        ]}
      >
        <Text style={[styles.primaryCtaLabel, { color: roles.onAccent }]}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // Exacte AppHeader-match: padding 18 horizontaal + 36px hoog
    // → close-knop zit op precies dezelfde plek als de close in de
    // feed eronder. Geen vertical bounce bij open/close.
    paddingHorizontal: 18,
    height: 36,
    marginBottom: 8,
  },
  headerTitle: {
    fontFamily: fontFamily.displayBold,
    fontSize: 22,
    letterSpacing: -0.44,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollPad: {
    // 14 matcht /voor-jou's HORIZONTAL_PADDING (gedeeld met de
    // andere insta-vibe feeds), zodat content op dezelfde kolom
    // staat als de page eronder.
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 120,
  },
  kicker: {
    fontFamily: fontFamily.medium,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  title: {
    fontFamily: fontFamily.displayBold,
    fontSize: 26,
    letterSpacing: -0.52,
    lineHeight: 30,
    marginBottom: 8,
  },
  lead: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sceneTile: {
    width: '47%',
    paddingVertical: 18,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 92,
    gap: 8,
    justifyContent: 'flex-end',
  },
  sceneLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.3,
    lineHeight: 18,
  },
  flavorRow: {
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 14,
  },
  flavorLabel: {
    fontFamily: fontFamily.displayBold,
    fontSize: 18,
    letterSpacing: -0.36,
  },
  flavorSub: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    marginTop: 2,
  },
  sectionLabel: {
    fontFamily: fontFamily.medium,
    fontSize: 11,
    letterSpacing: 0.55,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  venueList: { gap: 8 },
  venueTile: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  venueName: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.3,
    flex: 1,
    marginRight: 10,
  },
  errorText: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    paddingVertical: 16,
  },
  tipFooter: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 24,
    fontStyle: 'italic',
  },
  singleCtaWrap: {
    position: 'absolute',
    bottom: 32,
    left: 14,
    right: 14,
  },
  dualCtaWrap: {
    position: 'absolute',
    bottom: 32,
    left: 14,
    right: 14,
    flexDirection: 'row',
    gap: 10,
  },
  primaryCta: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryCtaLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.3,
  },
  secondaryCta: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryCtaLabel: {
    fontFamily: fontFamily.bold,
    fontSize: 14,
    letterSpacing: -0.28,
  },
});
