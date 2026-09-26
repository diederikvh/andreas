import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountWall } from '@/components/AccountWall';
import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { SettingsAction, SettingsGroup } from '@/components/SettingsList';
import { SpinningCross } from '@/components/SpinningCross';
import type { ApiAlert, ApiFoundItem } from '@/lib/api';
import { useIsRegistered } from '@/lib/authClient';
import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import { useAlerts, useFound } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Meldingen: de regels die je via je AI-assistent of hier instelt.
 *
 * Aan/uit en verwijderen zijn gewone knoppen. Toevoegen gaat als smaak in
 * je eigen woorden plus een grens (stad of soort), met eerst een proef: de
 * keurder op de server leest de laatste 25 kandidaten en zegt per event
 * waarom wel of niet. Geen vertaalstap; de omschrijving ís de regel.
 * Regels op een zaal of een vast genre, en feedback op treffers, lopen via
 * je eigen AI-assistent (via MCP) -- daarom onderaan de verwijzing naar /ai.
 */

export default function MeldingenScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const authed = useIsRegistered();
  const { data: alerts, isLoading, isError, refetch } = useAlerts({ enabled: authed });
  const { data: found } = useFound({ enabled: authed });

  const isNacht = useMode() === 'nacht';
  // De plus zit waar je 'm op elk ander scherm ook zoekt: rechtsboven,
  // geel en rond, naast het kruisje (zelfde knoppen als op /social).
  const header = (
    <AppHeader
      title={t('Meldingen', 'Alerts')}
      hideAvatar
      rightSlot={
        <View style={styles.headerActions}>
          {authed ? (
            <Pressable
              onPress={() => {
                softTap();
                router.push('/melding/nieuw' as never);
              }}
              hitSlop={8}
              style={[styles.headerAdd, { backgroundColor: roles.accent }]}
              accessibilityLabel={t('Nieuwe melding', 'New alert')}
            >
              <Ionicons name="add" size={20} color={roles.onAccent} />
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            style={[styles.closeBtn, { backgroundColor: isNacht ? palette.noir2 : palette.paper2 }]}
          >
            <Ionicons name="close" size={20} color={roles.fg} />
          </Pressable>
        </View>
      }
    />
  );

  if (!authed) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        <View style={{ flex: 1, paddingTop: insets.top + HEADER_HEIGHT }}>
          <AccountWall
            icon="notifications-outline"
            title={t('Meldingen', 'Alerts')}
            body={t(
              'Met een account zet je meldingen: je hoort het zodra er iets bijkomt dat bij je smaak past.',
              'With an account you can set alerts: you hear from us as soon as something comes in that fits your taste.',
            )}
          />
        </View>
        {header}
      </View>
    );
  }

  const list = alerts ?? [];
  // Leeg (en niet aan het invoeren): de uitleg midden op het scherm. Zodra
  // er meldingen zijn stapelen ze gewoon van boven naar beneden.
  const hits = found ?? [];
  // Leeg is: geen meldingen én niets gevonden (een gevolgde artiest kan
  // ook zonder meldingen iets opleveren).
  const empty = !isLoading && !isError && list.length === 0 && hits.length === 0;

  const claudeNote = (
    <View style={styles.claudeNote}>
      <Text style={[styles.claudeText, { color: roles.fgMuted }]}>
        {t(
          'Je kunt meldingen ook instellen met je eigen AI-assistent, zoals Claude of ChatGPT: bijvoorbeeld op een zaal of een genre, en zeggen wanneer een treffer niet klopte.',
          'You can also set alerts with your own AI assistant, like Claude or ChatGPT: for example on a venue or a genre, and say when a match was off.',
        )}
      </Text>
      <Pressable
        onPress={() => {
          softTap();
          void Linking.openURL('https://andreas.amsterdam/ai');
        }}
        hitSlop={10}
      >
        <Text style={[styles.claudeLink, { color: roles.fg }]}>{t('Hoe dat werkt →', 'How it works →')}</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + HEADER_HEIGHT + 8,
          paddingBottom: insets.bottom + 40,
        }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <SpinningCross size={24} color={roles.fgMuted} />
          </View>
        ) : null}

        {/* Een fout is geen lege lijst: "nog geen meldingen" zou liegen. */}
        {isError ? (
          <Pressable onPress={() => void refetch()} style={styles.errorWrap}>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {t('Je meldingen konden niet geladen worden.', 'Your alerts could not be loaded.')}
            </Text>
            <Text style={[styles.claudeLink, { color: roles.fg }]}>{t('Opnieuw proberen', 'Try again')}</Text>
          </Pressable>
        ) : null}

        {empty ? (
          <View style={styles.emptyWrap}>
            {/* Zelfde maat en kleur als de icoontjes op de lege staten
                elders (AccountWall). */}
            <View style={styles.emptyIcon}>
              <Ionicons name="notifications-outline" size={48} color={roles.fgMuted} />
            </View>
            <Text style={[styles.empty, { color: roles.fgMuted }]}>
              {t(
                'Nog geen meldingen. Omschrijf waar je van wil horen, dan krijg je om 10:00 bericht als er iets nieuws bijkomt dat past.',
                'No alerts yet. Describe what you want to hear about, and you get a message at 10:00 when something new comes in that fits.',
              )}
            </Text>
            {claudeNote}
          </View>
        ) : (
          <>
            {/* Hier landt de gebundelde push ("3 nieuwe dingen voor jou"):
                alles wat je meldingen en gevolgde artiesten vonden, met
                waarom. Op /new stond het tussen al het andere. */}
            {hits.length > 0 ? (
              <SettingsGroup header={t('Gevonden voor jou', 'Found for you')} style={styles.group}>
                {hits.map((hit) => (
                  <FoundRow key={hit.eventId} hit={hit} />
                ))}
              </SettingsGroup>
            ) : null}
            {list.length > 0 ? (
              <SettingsGroup
                header={hits.length > 0 ? t('Je meldingen', 'Your alerts') : undefined}
                style={hits.length > 0 ? undefined : styles.group}
              >
                {list.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} />
                ))}
              </SettingsGroup>
            ) : null}
            {!isLoading && !isError && (list.length > 0 || hits.length > 0) ? claudeNote : null}
          </>
        )}
      </ScrollView>
      {header}
    </View>
  );
}

const cityName = (c: string) => c.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');

/** Een treffer: titel, waar en wanneer, en waarom het hier staat. */
function FoundRow({ hit }: { hit: ApiFoundItem }) {
  const t = useT();
  const locale = useLocale();
  const d = new Date(hit.startsAt);
  const when = Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(locale === 'en' ? 'en-GB' : 'nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  const where = hit.city !== 'amsterdam' ? `${hit.venue} (${cityName(hit.city)})` : hit.venue;
  const sub = [[where, when].filter(Boolean).join(' · '), hit.reason].filter(Boolean).join(' — ');
  return (
    <SettingsAction
      label={hit.title}
      sub={sub}
      // Nog niet gemeld: komt in de push van 10:00.
      value={hit.sent ? undefined : t('Om 10:00', 'At 10:00')}
      onPress={() => router.push(`/event/${hit.eventId}?source=other` as never)}
    />
  );
}

/**
 * Een melding als lijstitem met pijltje, zoals de rijen op je profiel: je
 * ziet meteen dat je erop kan tikken. Aan/uit en verwijderen zitten op
 * het detailscherm.
 */
function AlertRow({ alert }: { alert: ApiAlert }) {
  const t = useT();
  // Bij een smaakregel is de omschrijving de titel; eronder de grenzen en
  // wat hij het laatst vond. Een vaste regel heeft alleen z'n label.
  const title = alert.taste ?? alert.label;
  const bounds = alert.taste ? alert.label.replace(/^smaak: "[^"]*"( · )?/, '') : '';
  const last = alert.hits[0] ? t(`laatst: ${alert.hits[0].title}`, `latest: ${alert.hits[0].title}`) : '';
  const sub = [bounds, last].filter(Boolean).join(' · ');
  const state = alert.expired ? t('Verlopen', 'Expired') : !alert.active ? t('Uit', 'Off') : undefined;
  return (
    <SettingsAction
      label={title}
      sub={sub || undefined}
      value={state}
      onPress={() => router.push(`/melding/${alert.id}` as never)}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerAdd: { width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  // Vult de ruimte onder de header en zet de uitleg in het midden.
  // SettingsGroup heeft eigen marge bovenin; hier zit de header al boven.
  group: { marginTop: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', gap: 4, paddingBottom: 60 },
  emptyIcon: { alignItems: 'center', paddingBottom: 14 },
  center: { paddingTop: 40, alignItems: 'center' },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 32,
    textAlign: 'center',
  },
  errorWrap: { alignItems: 'center', gap: 8, paddingTop: 24 },
  claudeNote: { paddingHorizontal: 32, paddingTop: 28, alignItems: 'center', gap: 8 },
  claudeText: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  claudeLink: { fontFamily: fontFamily.bold, fontSize: 13.5 },
});
