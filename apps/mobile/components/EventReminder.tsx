import DateTimePicker from '@react-native-community/datetimepicker';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

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
  endsAt,
  onNeedsRoom,
}: {
  occurrenceId: string;
  startsAt: string | null;
  /** Eindtijd, als die er is. Bij een expositie die maanden loopt is de
      begintijd allang geweest en zegt die niets over wat nog kan. */
  endsAt?: string | null;
  /**
   * Hoeveel punten dit blok omhoog moet om boven het keyboard uit te
   * komen. Het scherm eromheen scrollt, niet wij: dat is dezelfde
   * afspraak als bij de uitnodigingsbanner hierboven in het scherm.
   *
   * Niet `automaticallyAdjustKeyboardInsets`: die scrollt precies genoeg
   * voor het invoerveld en niets voor de knoppen eronder, en juist die
   * knoppen heb je nodig om te versturen.
   */
  onNeedsRoom?: (overflow: number) => void;
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
  const box = useRef<View>(null);
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    if (!open || !onNeedsRoom) return;
    const sub = Keyboard.addListener('keyboardDidShow', (e) => {
      const kb = e.endCoordinates?.height ?? 0;
      if (kb <= 0) return;
      box.current?.measureInWindow((_x, y, _w, height) => {
        // 20 punten lucht onder de knoppen, zodat ze niet tegen het
        // keyboard aan plakken.
        const overflow = y + height - (windowHeight - kb - 20);
        if (overflow > 0) onNeedsRoom(overflow);
      });
    });
    return () => sub.remove();
  }, [open, onNeedsRoom, windowHeight]);
  const [note, setNote] = useState('');

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
      { occurrenceId, fireAt: when, note: note.trim() || undefined },
      {
        onSuccess: () => {
          setOpen(false);
          setNote('');
        },
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
    <View ref={box}>
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
      </View>

      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder={t('Waarvoor? (optioneel)', 'What for? (optional)')}
        placeholderTextColor={roles.fgPlaceholder}
        maxLength={80}
        multiline
        numberOfLines={2}
        textAlignVertical="top"
        style={[
          styles.note,
          {
            color: roles.fg,
            backgroundColor:
              mode === 'nacht'
                ? 'rgba(118,118,128,0.24)'
                : 'rgba(118,118,128,0.12)',
          },
        ]}
      />

      <View style={styles.actions}>
        <Pressable
          onPress={onSave}
          disabled={inPast || save.isPending}
          style={[
            styles.saveBtn,
            {
              backgroundColor: inPast ? roles.bgChip : roles.accent,
            },
          ]}
        >
          <Text
            style={[
              styles.saveText,
              { color: inPast ? roles.fgMuted : '#0a0a0b' },
            ]}
          >
            {existing ? t('Verzetten', 'Move it') : t('Zet hem', 'Set it')}
          </Text>
        </Pressable>
        <Pressable onPress={() => setOpen(false)} hitSlop={8}>
          <Text style={[styles.action, { color: roles.fgMuted }]}>
            {t('Laat maar', 'Never mind')}
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
  // De compacte date picker van iOS tekent z'n pil met een paar punten
  // lucht binnen z'n eigen vak. Zonder correctie begint hij dus iets
  // rechter dan het notitieveld eronder, en juist bij twee velden onder
  // elkaar zie je dat.
  pickers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginLeft: -10,
  },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 19,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 62,
  },
  // Links uitlijnen met de rest van het blok, en bevestigen vóór afzien:
  // de knop die je bijna altijd wil staat waar je duim al is.
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  action: { fontFamily: fontFamily.bold, fontSize: 14 },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8 },
  saveText: { fontFamily: fontFamily.bold, fontSize: 14 },
});
