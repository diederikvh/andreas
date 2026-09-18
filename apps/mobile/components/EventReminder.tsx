import DateTimePicker from '@react-native-community/datetimepicker';
import { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  useDeleteReminder,
  useReminders,
  useSetReminder,
} from '@/lib/queries';
import { SettingsAction } from '@/components/SettingsList';
import { useMode, useRoles } from '@/store/mode';
import { fontFamily } from '@/theme/tokens';

/**
 * "Herinner me hieraan" op een event.
 *
 * Voor de avond zelf hoef je niets te doen: red je iets, dan krijg je de
 * avond ervoor en op de dag zelf vanzelf bericht. Dít is voor het moment
 * dat Andreas niet kan weten — en dat is in de praktijk de kaartverkoop.
 * Wanneer die opengaat staat nergens in wat we binnenhalen: van de
 * toekomstige voorstellingen hebben er 11.514 een ticketlink en 22 niet,
 * dus die link verschijnt tegelijk met het event en zegt niets over de
 * verkoop. Dat moment weet jij van een socialpost of een nieuwsbrief, en
 * daarom zet jij 'm.
 *
 * Eén per avond. Nog een keer instellen verzet 'm, in plaats van er een
 * tweede naast te zetten — "herinner me" is geen lijst die je aanlegt.
 */
export function EventReminder({
  occurrenceId,
  startsAt,
}: {
  occurrenceId: string;
  startsAt: string | null;
}) {
  const roles = useRoles();
  const mode = useMode();
  const t = useT();
  const locale = useLocale();
  const { data: reminders } = useReminders();
  const save = useSetReminder();
  const remove = useDeleteReminder();

  const existing = reminders?.find((r) => r.occurrenceId === occurrenceId);
  const [open, setOpen] = useState(false);

  /**
   * Standaard drie dagen voor de avond, om 10:00.
   *
   * Dat is een moment waar je iets mee kunt: nog tijd om kaarten te
   * regelen of iemand mee te vragen, en dicht genoeg op de datum om het
   * niet te vergeten. Van daaruit schuif je zelf naar voren of naar
   * achteren. Staat de avond binnen drie dagen, dan is dat moment al
   * geweest en pakken we een uur vanaf nu -- die datum kan altijd.
   */
  const defaultWhen = () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    if (!startsAt) return soon;
    const d = new Date(startsAt);
    if (Number.isNaN(d.getTime())) return soon;
    d.setDate(d.getDate() - 3);
    d.setHours(10, 0, 0, 0);
    return d.getTime() > Date.now() ? d : soon;
  };
  const [when, setWhen] = useState(defaultWhen);

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'nl' ? 'nl-NL' : 'en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale]
  );

  // Alleen het onmogelijke houden we tegen: een moment in het verleden
  // kan niet meer afgaan, en dat weigert de server ook. Wanneer je
  // eraan herinnerd wil worden is verder aan jou -- ook als dat na
  // afloop is. Daar stond eerder een waarschuwing bij en die vertelde
  // je iets wat je zelf al bedoeld had.
  const inPast = when.getTime() <= Date.now();

  const onSave = () => {
    if (inPast) return;
    softTap();
    save.mutate(
      { occurrenceId, fireAt: when },
      {
        onSuccess: () => setOpen(false),
        onError: (e) =>
          Alert.alert(
            t('Niet gelukt', 'Did not work'),
            (e as Error).message ?? ''
          ),
      }
    );
  };

  const onRemove = () => {
    if (!existing) return;
    softTap();
    remove.mutate(existing.id);
  };

  // De kop blijft staan als het openklapt: zonder kop verdwijnt de rij
  // uit de lijst en is er niets meer om op te tikken om 'm weer dicht te
  // doen -- dan moet je "Laat maar" gebruiken, en dat leest als
  // annuleren in plaats van inklappen.
  const head = (
    <SettingsAction
      icon="alarm-outline"
      label={t('Herinner me', 'Remind me')}
      value={existing ? fmt.format(new Date(existing.fireAt)) : undefined}
      valueAccent
      expanded={open}
      onPress={() => {
        // Openklappen begint bij wat er staat, niet bij het voorstel:
        // "Verzetten" met een ander moment in de pickers dan je zelf
        // hebt gezet leest als een tweede herinnering.
        if (!open) setWhen(existing ? new Date(existing.fireAt) : defaultWhen());
        setOpen((o) => !o);
      }}
    />
  );

  if (!open) return head;

  return (
    <View>
      {head}
      <View style={styles.sheet}>
      <View style={styles.pickers}>
        <DateTimePicker
          value={when}
          mode="date"
          display={Platform.OS === 'ios' ? 'compact' : 'default'}
          themeVariant={mode === 'nacht' ? 'dark' : 'light'}
          minimumDate={new Date()}
          onChange={(_, picked) => {
            if (!picked) return;
            const next = new Date(when);
            next.setFullYear(
              picked.getFullYear(),
              picked.getMonth(),
              picked.getDate()
            );
            setWhen(next);
          }}
        />
        <DateTimePicker
          value={when}
          mode="time"
          display={Platform.OS === 'ios' ? 'compact' : 'default'}
          themeVariant={mode === 'nacht' ? 'dark' : 'light'}
          onChange={(_, picked) => {
            if (!picked) return;
            const next = new Date(when);
            next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
            setWhen(next);
          }}
        />
        {/* Achter de tijd, want daar eindigt je blik: datum, tijd,
            klaar. Geen afzien-knop ernaast -- de kop erboven klapt 'm
            net zo goed weer dicht, en die zit er toch al. */}
        <Pressable
          onPress={onSave}
          disabled={inPast || save.isPending}
          style={[
            styles.saveBtn,
            { backgroundColor: inPast ? roles.bgChip : roles.accent },
          ]}
        >
          <Text
            style={[
              styles.saveText,
              { color: inPast ? roles.fgMuted : '#0a0a0b' },
            ]}
          >
            {t('Zet', 'Set')}
          </Text>
        </Pressable>
        {existing ? (
          <Pressable
            onPress={() => {
              onRemove();
              setOpen(false);
            }}
            hitSlop={8}
          >
            <Text style={[styles.action, { color: roles.fgMuted }]}>
              {t('Weghalen', 'Remove')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingHorizontal: 16, paddingBottom: 14, gap: 12 },
  // Datum, tijd en de knop op één regel. De compacte date picker van
  // iOS tekent z'n pil met een paar punten lucht binnen z'n eigen vak,
  // dus zonder deze correctie begint hij rechter dan de tekst van de
  // rij erboven.
  pickers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: -10,
  },
  action: { fontFamily: fontFamily.bold, fontSize: 14 },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8 },
  saveText: { fontFamily: fontFamily.bold, fontSize: 14 },
});
