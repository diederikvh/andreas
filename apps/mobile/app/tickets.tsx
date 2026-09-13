import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { File } from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader, HEADER_HEIGHT } from '@/components/AppHeader';
import { useLocale, useT } from '@/lib/i18n';
import { dowMixed, monthShort } from '@/lib/eventDisplay';
import { useRoles } from '@/store/mode';
import {
  ticketFileUri,
  useAllTickets,
  useTickets,
  type StoredTicket,
} from '@/store/tickets';
import { fontFamily } from '@/theme/tokens';

/**
 * Je bewaarde kaartjes, op één plek.
 *
 * Lang was dit er met opzet niet: een ticket hoort bij een avond, niet in
 * een mapje. Maar ná die avond verdwijnt de avond uit je plannen, en dan
 * was het bestand onbereikbaar — je kon het niet meer tonen en niet meer
 * weggooien. Het stond er nog wel, met je naam en een code erop.
 *
 * **Automatisch weggooien doen we niet.** Een kaartje is ook een bonnetje
 * en een herinnering, en stilletjes iemands bestand wissen kan je niet
 * terugdraaien. In plaats daarvan: hier staat wat er is, afgelopen avonden
 * apart, en één knop om die in één keer op te ruimen.
 */
export default function TicketsScreen() {
  const roles = useRoles();
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const tickets = useAllTickets();
  const detach = useTickets((s) => s.detach);

  // Welke bestanden staan er nog écht? Een kaartje van vóór 13 sep kan
  // door de oude opruimer gewist zijn (die vergeleek hele paden, en het
  // pad naar de document-map verandert bij elke installatie). De rij mag
  // dan niet doen alsof er nog iets te tonen valt.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  useEffect(() => {
    const gone = new Set<string>();
    for (const ticket of tickets) {
      try {
        if (!new File(ticketFileUri(ticket.fileUri)).exists) {
          gone.add(ticket.fileUri);
        }
      } catch {
        gone.add(ticket.fileUri);
      }
    }
    setMissing(gone);
  }, [tickets]);

  // De avond is voorbij als hij meer dan een halve nacht geleden begon.
  // Zonder datum (kaartjes van vóór deze lijst) gokken we niet: die staan
  // bij "bewaard", zodat je ze zelf kan beoordelen.
  const now = Date.now();
  const past = (ticket: StoredTicket) => {
    const at = ticket.startsAt ? new Date(ticket.startsAt).getTime() : NaN;
    return !Number.isNaN(at) && at < now - 8 * 3600_000;
  };
  const upcoming = tickets.filter((x) => !past(x));
  const done = tickets.filter(past);

  const removeAllPast = () => {
    Alert.alert(
      t('Afgelopen kaartjes weggooien?', 'Delete past tickets?'),
      t(
        `${done.length} bestand${done.length === 1 ? '' : 'en'} van avonden die geweest zijn. Weg is weg.`,
        `${done.length} file${done.length === 1 ? '' : 's'} from nights that have passed. Gone is gone.`,
      ),
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Weggooien', 'Delete'),
          style: 'destructive',
          onPress: () => {
            for (const ticket of done) detach(ticket.occurrenceId, ticket.fileUri);
          },
        },
      ],
    );
  };

  const dayLabel = (d: Date) =>
    `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
      d.getMonth(),
      locale,
    ).toLowerCase()} ${d.getFullYear()}`;

  const Row = ({ ticket }: { ticket: StoredTicket }) => {
    const when = ticket.startsAt ? new Date(ticket.startsAt) : null;
    // Kaartjes van vóór deze lijst weten hun avond niet. Dan maar zeggen
    // wanneer je 'm bewaarde: dat is genoeg om 'm te herkennen, en het is
    // eerlijker dan "onbekend".
    const label =
      when && !Number.isNaN(when.getTime())
        ? dayLabel(when)
        : t(
            `Bewaard op ${dayLabel(new Date(ticket.addedAt))}`,
            `Saved on ${dayLabel(new Date(ticket.addedAt))}`,
          );

    const gone = missing.has(ticket.fileUri);

    return (
      <Pressable
        onPress={() =>
          gone
            ? null
            : router.push(`/ticket/${ticket.occurrenceId}` as never)
        }
        style={[
          styles.row,
          { backgroundColor: roles.bgChip },
          gone ? styles.rowGone : null,
        ]}
      >
        <Ionicons
          name={gone ? 'alert-circle-outline' : 'ticket-outline'}
          size={20}
          color={roles.fgMuted}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: roles.fg }]}>
            {ticket.eventTitle ?? t('Naamloos', 'Untitled')}
          </Text>
          <Text style={[styles.rowMeta, { color: roles.fgMuted }]}>
            {gone ? t('Bestand is er niet meer', 'File is gone') : label}
          </Text>
        </View>

        <Pressable
          hitSlop={10}
          onPress={() =>
            Alert.alert(
              t('Dit kaartje weggooien?', 'Delete this ticket?'),
              t(
                'Het bestand wordt van dit toestel gewist. Je "ik ga" blijft staan.',
                'The file is erased from this device. Your "going" stays.',
              ),
              [
                { text: t('Annuleren', 'Cancel'), style: 'cancel' },
                {
                  text: t('Verwijderen', 'Delete'),
                  style: 'destructive',
                  onPress: () => detach(ticket.occurrenceId, ticket.fileUri),
                },
              ],
            )
          }
        >
          <Ionicons name="trash-outline" size={18} color={roles.fgMuted} />
        </Pressable>
      </Pressable>
    );
  };

  const closeBtn = (
    <Pressable onPress={() => router.back()} hitSlop={8} style={styles.closeBtn}>
      <Ionicons name="close" size={20} color={roles.fg} />
    </Pressable>
  );

  return (
    <View style={[styles.root, { backgroundColor: roles.bg }]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + HEADER_HEIGHT + 12,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: 22,
          gap: 10,
        }}
      >
        {tickets.length === 0 ? (
          <Text style={[styles.empty, { color: roles.fgMuted }]}>
            {t(
              'Je hebt nog geen kaartjes bewaard. Deel er een met Andreas en hij staat hier.',
              'You have not saved any tickets yet. Share one with Andreas and it will be here.',
            )}
          </Text>
        ) : null}

        {upcoming.map((ticket) => (
          <Row key={ticket.fileUri} ticket={ticket} />
        ))}

        {done.length > 0 ? (
          <>
            <View style={styles.groupHead}>
              <Text style={[styles.groupTitle, { color: roles.fgMuted }]}>
                {t('Geweest', 'Past')}
              </Text>
              <Pressable onPress={removeAllPast} hitSlop={8}>
                <Text style={[styles.clearAll, { color: roles.accent }]}>
                  {t('Alles opruimen', 'Clear all')}
                </Text>
              </Pressable>
            </View>
            {done.map((ticket) => (
              <Row key={ticket.fileUri} ticket={ticket} />
            ))}
          </>
        ) : null}

        {tickets.length > 0 ? (
          <Text style={[styles.note, { color: roles.fgPlaceholder }]}>
            {t(
              'Deze bestanden staan alleen op dit toestel. Andreas gooit ze nooit uit zichzelf weg.',
              'These files are on this device only. Andreas never deletes them on its own.',
            )}
          </Text>
        ) : null}
      </ScrollView>

      <AppHeader title={t('Kaartjes', 'Tickets')} hideAvatar rightSlot={closeBtn} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
  },
  // Weg is weg, maar de rij blijft staan tot jij 'm weghaalt: zo zie je
  // wat er ooit was in plaats van dat het stil verdwijnt.
  rowGone: { opacity: 0.55 },
  rowTitle: { fontFamily: fontFamily.bold, fontSize: 15, letterSpacing: -0.2 },
  rowMeta: { fontFamily: fontFamily.body, fontSize: 12 },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 2,
  },
  groupTitle: {
    fontFamily: fontFamily.display,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  clearAll: { fontFamily: fontFamily.bold, fontSize: 13 },
  empty: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 40,
    textAlign: 'center',
  },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 18,
    textAlign: 'center',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
