import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { softTap } from '@/lib/haptics';
import { useLocale, useT } from '@/lib/i18n';
import {
  useDeleteReminder,
  useReminders,
  useSetReminder,
} from '@/lib/queries';
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

  // De avond zelf ligt al vast via je hartje; een herinnering ná afloop
  // is geen herinnering. Dus dit kan alleen vooruit, en niet verder dan
  // het event zelf.
  const eventTime = startsAt ? new Date(startsAt).getTime() : null;
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

  if (existing && !open) {
    return (
      <View style={[styles.set, { backgroundColor: roles.bgChip }]}>
        <Ionicons name="alarm" size={18} color={roles.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.setTitle, { color: roles.fg }]}>
            {existing.note?.trim()
              ? existing.note
              : t('Je krijgt bericht', 'You will get a ping')}
          </Text>
          <Text style={[styles.setWhen, { color: roles.fgMuted }]}>
            {fmt.format(new Date(existing.fireAt))}
          </Text>
        </View>
        <Pressable onPress={() => setOpen(true)} hitSlop={8}>
          <Text style={[styles.action, { color: roles.fgMuted }]}>
            {t('Wijzig', 'Change')}
          </Text>
        </Pressable>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Ionicons name="close" size={18} color={roles.fgMuted} />
        </Pressable>
      </View>
    );
  }

  if (!open) {
    return (
      <Pressable
        onPress={() => {
          softTap();
          setOpen(true);
        }}
        style={[styles.row, { borderColor: roles.bgChip }]}
      >
        <Ionicons name="alarm-outline" size={18} color={roles.fgMuted} />
        <Text style={[styles.rowText, { color: roles.fg }]}>
          {t('Herinner me hieraan', 'Remind me about this')}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={roles.fgPlaceholder} />
      </Pressable>
    );
  }

  return (
    <View style={[styles.sheet, { backgroundColor: roles.bgChip }]}>
      <Text style={[styles.hint, { color: roles.fgMuted }]}>
        {t(
          'Voor de avond zelf hoef je niets te doen — dat gaat vanzelf. Dit is voor bijvoorbeeld het moment dat de kaartverkoop opengaat.',
          'You do not need this for the night itself — that happens automatically. Use it for things like the moment tickets go on sale.'
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
        style={[
          styles.note,
          { color: roles.fg, borderColor: roles.fgPlaceholder },
        ]}
      />

      {inPast || tooLate ? (
        <Text style={[styles.warn, { color: roles.fgMuted }]}>
          {inPast
            ? t('Kies een moment in de toekomst.', 'Pick a moment in the future.')
            : t(
                'Dat is ná de voorstelling — kies iets ervoor.',
                'That is after the show — pick something before it.'
              )}
        </Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable onPress={() => setOpen(false)} hitSlop={8}>
          <Text style={[styles.action, { color: roles.fgMuted }]}>
            {t('Laat maar', 'Never mind')}
          </Text>
        </Pressable>
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 22,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  rowText: { flex: 1, fontFamily: fontFamily.bold, fontSize: 15 },
  set: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 22,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  setTitle: { fontFamily: fontFamily.bold, fontSize: 14.5 },
  setWhen: { fontFamily: fontFamily.body, fontSize: 12.5 },
  sheet: {
    marginHorizontal: 22,
    marginTop: 12,
    padding: 14,
    borderRadius: 14,
    gap: 12,
  },
  hint: { fontFamily: fontFamily.body, fontSize: 12.5, lineHeight: 18 },
  pickers: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  warn: { fontFamily: fontFamily.body, fontSize: 12.5 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 16,
  },
  action: { fontFamily: fontFamily.bold, fontSize: 14 },
  saveBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999 },
  saveText: { fontFamily: fontFamily.bold, fontSize: 14 },
});
