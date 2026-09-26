import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SpinningCross } from '@/components/SpinningCross';
import { softTap } from '@/lib/haptics';
import { useT } from '@/lib/i18n';
import { useAlerts, useDeleteAlert, useSetAlertActive } from '@/lib/queries';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Eén melding: wat hij zoekt, of hij aan staat, wat hij recent vond, en
 * verwijderen. Verwijderen zit bewust alleen hier en niet in het overzicht:
 * het is onomkeerbaar (ook de feedback gaat weg), en in een lijst tik je
 * er zo per ongeluk op.
 *
 * Leest uit dezelfde query als het overzicht; een eigen endpoint is niet
 * nodig zolang de lijst klein is.
 */
export default function MeldingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const roles = useRoles();
  const isNacht = useMode() === 'nacht';
  const insets = useSafeAreaInsets();
  const t = useT();
  const { data: alerts, isLoading } = useAlerts();
  const setActive = useSetAlertActive();
  const remove = useDeleteAlert();
  const alert = (alerts ?? []).find((a) => a.id === id);

  // Geen logo-header: de omschrijving is de titel. Alleen het kruisje.
  const header = (
    <View style={[styles.topBar, { paddingTop: insets.top + 6 }]}>
      <Pressable
        onPress={() => router.back()}
        hitSlop={8}
        style={[styles.closeBtn, { backgroundColor: isNacht ? palette.noir2 : palette.paper2 }]}
        accessibilityLabel={t('Sluiten', 'Close')}
      >
        <Ionicons name="close" size={20} color={roles.fg} />
      </Pressable>
    </View>
  );

  if (!alert) {
    return (
      <View style={[styles.root, { backgroundColor: roles.bg }]}>
        {header}
        <View style={[styles.center, { paddingTop: 60 }]}>
          {isLoading ? (
            <SpinningCross size={24} color={roles.fgMuted} />
          ) : (
            <Text style={[styles.body, { color: roles.fgMuted }]}>
              {t('Deze melding bestaat niet meer.', 'This alert no longer exists.')}
            </Text>
          )}
        </View>
      </View>
    );
  }

  const title = alert.taste ?? alert.label;
  const bounds = alert.taste ? alert.label.replace(/^smaak: "[^"]*"( · )?/, '') : null;

  const confirmDelete = () => {
    softTap();
    Alert.alert(
      t('Melding verwijderen?', 'Delete alert?'),
      alert.taste
        ? t(
            'Ook wat de keurder van je feedback leerde gaat weg. Liever even pauzeren? Zet hem dan uit.',
            'What the judge learned from your feedback goes too. Rather pause it? Switch it off instead.',
          )
        : undefined,
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijderen', 'Delete'),
          style: 'destructive',
          onPress: () => {
            remove.mutate(alert.id);
            router.back();
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      {header}
      <ScrollView
        contentContainerStyle={{
          paddingTop: 12,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 22,
          gap: 18,
        }}
      >
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: roles.fg }]}>{title}</Text>
          {bounds ? <Text style={[styles.body, styles.centered, { color: roles.fgMuted }]}>{bounds}</Text> : null}
          {alert.expired ? (
            <Text style={[styles.body, styles.centered, { color: roles.fgMuted }]}>{t('Verlopen', 'Expired')}</Text>
          ) : null}
        </View>

        {/* De hele rij is de knop. Een losse Switch in een ScrollView mist
            korte tikken (de ScrollView houdt de aanraking even vast om te
            zien of je scrollt); een Pressable heeft daar geen last van. De
            Switch toont alleen nog de stand. */}
        <Pressable
          onPress={() => {
            softTap();
            setActive.mutate({ id: alert.id, active: !alert.active });
          }}
          style={[styles.switchRow, { backgroundColor: roles.bgChip }]}
          accessibilityRole="switch"
          accessibilityState={{ checked: alert.active }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.switchLabel, { color: roles.fg }]}>
              {alert.active ? t('Staat aan', 'On') : t('Staat uit', 'Off')}
            </Text>
            <Text style={[styles.small, { color: roles.fgMuted }]}>
              {t('Om 10:00 een bericht als er iets nieuws past.', 'A message at 10:00 when something new fits.')}
            </Text>
          </View>
          <View pointerEvents="none">
            <Switch
              value={alert.active}
              trackColor={{ true: roles.accent, false: isNacht ? '#2a2a2d' : palette.paper }}
              thumbColor={isNacht ? palette.ink : palette.paper3}
            />
          </View>
        </Pressable>

        {/* Bewerken kan alleen bij een smaakmelding: die heeft een
            omschrijving om aan te passen. Een melding op een zaal of genre
            (via je AI-assistent) pas je daar aan. */}
        {alert.taste ? (
          <Pressable
            onPress={() => {
              softTap();
              router.push(`/melding/nieuw?id=${alert.id}` as never);
            }}
            style={[styles.deleteBtn, { backgroundColor: roles.bgChip }]}
          >
            <Text style={[styles.deleteLabel, { color: roles.fg }]}>{t('Bewerken', 'Edit')}</Text>
          </Pressable>
        ) : (
          <Text style={[styles.small, styles.centered, { color: roles.fgMuted }]}>
            {t(
              'Deze melding is op een zaal of genre gezet. Aanpassen doe je via je AI-assistent.',
              'This alert is set on a venue or genre. Change it through your AI assistant.',
            )}
          </Text>
        )}

        <Pressable onPress={confirmDelete} style={[styles.deleteBtn, { backgroundColor: roles.bgChip }]}>
          <Text style={[styles.deleteLabel, { color: roles.fg }]}>{t('Verwijderen', 'Delete')}</Text>
        </Pressable>

        <View style={{ gap: 10 }}>
          <Text style={[styles.section, { color: roles.fg }]}>{t('Recent gevonden', 'Recently found')}</Text>
          {alert.hits.length === 0 ? (
            <Text style={[styles.body, { color: roles.fgMuted }]}>
              {t(
                'Nog niets. Zodra er iets nieuws binnenkomt dat past, staat het hier, met waarom.',
                'Nothing yet. As soon as something new comes in that fits, it shows up here, with why.',
              )}
            </Text>
          ) : (
            alert.hits.map((hit) => (
              <Pressable
                key={hit.eventId}
                onPress={() => router.push(`/event/${hit.eventId}?source=other` as never)}
                style={{ gap: 2 }}
              >
                <Text style={[styles.hitTitle, { color: roles.fg }]}>{hit.title}</Text>
                <Text style={[styles.small, { color: roles.fgMuted }]}>
                  {hit.venue}
                  {hit.reason ? ` — ${hit.reason}` : ''}
                </Text>
              </Pressable>
            ))
          )}
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  closeBtn: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', paddingHorizontal: 32 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 4 },
  // De omschrijving is de titel: gecentreerd, met lucht eromheen.
  titleWrap: { gap: 8, alignItems: 'center', paddingHorizontal: 8, paddingTop: 8, paddingBottom: 10 },
  title: { fontFamily: fontFamily.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.4, textAlign: 'center' },
  body: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
  centered: { textAlign: 'center' },
  small: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 18 },
  section: { fontFamily: fontFamily.bold, fontSize: 15 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12 },
  switchLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
  hitTitle: { fontFamily: fontFamily.bold, fontSize: 14.5 },
  deleteBtn: { alignItems: 'center', justifyContent: 'center', paddingVertical: 13, borderRadius: 8 },
  deleteLabel: { fontFamily: fontFamily.bold, fontSize: 15 },
});
