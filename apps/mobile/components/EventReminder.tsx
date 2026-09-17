import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
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
import { LEAD } from '@/components/SettingsList';
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
  // Standaard morgenochtend om 10:00. Een verkoop start zelden vannacht,
  // en een voorstel dat al bijna verlopen is nodigt niet uit.
  const [when, setWhen] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d;
  });

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

  // Een herinnering ná afloop is geen herinnering. De grens is het
  // *einde*, niet het begin: een expositie die tot november loopt is op
  // 3 juli begonnen, en daar in september aan herinnerd worden kan
  // prima. Keek dit naar startsAt, dan stond de knop bij elke lopende
  // expositie dood.
  const last = endsAt ?? startsAt;
  const eventTime = last ? new Date(last).getTime() : null;
  const tooLate = eventTime !== null && when.getTime() > eventTime;
  const inPast = when.getTime() <= Date.now();

  const onSave = () => {
    if (inPast || tooLate) return;
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
    <Pressable
      onPress={() => {
        softTap();
        setOpen((o) => !o);
      }}
      style={styles.row}
    >
      <View style={styles.lead}>
        <Ionicons name="alarm-outline" size={22} color={roles.accent} />
      </View>
      <Text style={[styles.rowText, { color: roles.fg }]}>
        {t('Herinner me', 'Remind me')}
      </Text>
      {existing ? (
        <Text style={[styles.value, { color: roles.accent }]}>
          {fmt.format(new Date(existing.fireAt))}
        </Text>
      ) : null}
      {/* Precies het pijltje van SettingsAction: daar is het een Ionicon
          van 15 en hier stond een mono-teken van 14, en naast elkaar zie
          je dat als twee verschillende maten. */}
      <Ionicons
        name={open ? 'chevron-up' : 'chevron-forward'}
        size={15}
        color={roles.fgPlaceholder}
      />
    </Pressable>
  );

  if (!open) return head;

  return (
    <View ref={box}>
      {head}
      <View style={styles.sheet}>
      <Text style={[styles.hint, { color: roles.fgMuted }]}>
        {t(
          'De avond zelf gaat vanzelf. Dit is voor bijvoorbeeld de kaartverkoop.',
          'The night itself happens automatically. Use this for things like ticket sales.'
        )}
      </Text>

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

      {inPast || tooLate ? (
        <Text style={[styles.warn, { color: roles.fgMuted }]}>
          {inPast
            ? t('Kies een moment in de toekomst.', 'Pick a moment in the future.')
            : t(
                'Dat is ná afloop. Kies iets ervoor.',
                'That is after it ends. Pick something before it.'
              )}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          onPress={onSave}
          disabled={inPast || tooLate || save.isPending}
          style={[
            styles.saveBtn,
            {
              backgroundColor:
                inPast || tooLate ? roles.bgChip : roles.accent,
            },
          ]}
        >
          <Text
            style={[
              styles.saveText,
              { color: inPast || tooLate ? roles.fgMuted : '#0a0a0b' },
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
  // Eén op één de maten van de "Nodig iemand uit"-rij hierboven in het
  // scherm: zelfde gap, zelfde padding, zelfde letterdikte en hetzelfde
  // mono-chevron. Stond eerder op eigen maten en dan zie je meteen dat
  // het twee verschillende dingen zijn, terwijl het dezelfde soort rij is.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  lead: { width: LEAD, alignItems: 'center' },
  rowText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
  value: { fontFamily: fontFamily.body, fontSize: 14 },
  set: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  setTitle: {
    fontFamily: fontFamily.medium,
    fontSize: 14.5,
    letterSpacing: -0.07,
  },
  setWhen: { fontFamily: fontFamily.body, fontSize: 12.5 },
  sheet: { paddingHorizontal: 16, paddingBottom: 14, gap: 12 },
  hint: { fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 18 },
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
  warn: { fontFamily: fontFamily.body, fontSize: 12.5 },
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
