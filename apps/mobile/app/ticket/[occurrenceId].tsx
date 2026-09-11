import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SpinningCross } from '@/components/SpinningCross';
import { ZoomableImages } from '@/components/ZoomableImages';
import { useT } from '@/lib/i18n';
import {
  discardPdfRender,
  renderPdfPages,
  type PdfRender,
} from '@/lib/importPdf';
import { safeBack } from '@/lib/navigation';
import { useSheetTop } from '@/lib/sheetInset';
import { useTickets, useTicketsFor } from '@/store/tickets';
import { fontFamily, palette } from '@/theme/tokens';

/**
 * Jouw ticket, zo groot mogelijk.
 *
 * Twee dingen wijken hier bewust af van de rest van de app:
 *
 *  1. **Altijd wit, nooit nacht-modus.** Een scanner aan de deur leest een
 *     code van een scherm; donkergrijs met een lichte code erop maakt dat
 *     alleen moeilijker. Dit scherm is gereedschap, geen sfeer.
 *  2. **We tonen het originele bestand, geen nagemaakte QR.** Andreas leest
 *     de inhoud van de code niet uit (zie `lib/importBarcode.ts`), dus we
 *     kunnen hem niet reconstrueren — en dat is precies de bedoeling. Wat
 *     je ziet is het bestand dat je zelf gaf.
 *
 * Het bestand staat in `Documents/import/` en gaat nergens naartoe. Een PDF
 * wordt bij het openen lokaal naar een afbeelding gerenderd en die render
 * gooien we bij het sluiten weer weg.
 *
 * **Let op bij PDF-tickets:** die render is op mediaBox-maat (A4 ≈ 595px
 * breed), dus de QR komt op zo'n 100-150px uit. Op het scherm groot genoeg
 * om te zien, maar of een scanner aan de deur dat leest is niet getest. Dat
 * moet één keer met een echt ticket aan een echte deur; lukt het niet, dan
 * is 2× renderen de oplossing (zie `lib/importPdf.ts`).
 */
export default function TicketScreen() {
  const { occurrenceId: raw } = useLocalSearchParams<{
    occurrenceId: string;
  }>();
  const occurrenceId = raw ?? '';
  const insets = useSafeAreaInsets();
  // Dit scherm gaat ook open vanuit het importsheet; daar zit je al onder
  // de notch en is de safe-area-inset dubbelop.
  const { top, onLayout } = useSheetTop(8);
  const t = useT();

  const tickets = useTicketsFor(occurrenceId);
  const ticket = tickets[0];
  const detach = useTickets((s) => s.detach);

  const [pages, setPages] = useState<PdfRender[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (tickets.length === 0) return;
    let cancelled = false;
    let rendered: PdfRender[] = [];
    void (async () => {
      // Alle pagina's van alle tickets achter elkaar: een ticket van twee
      // kantjes moet je kunnen doorscrollen, de QR staat niet altijd op
      // pagina 1, en met z'n tweeën heb je twee bestanden.
      const all: PdfRender[] = [];
      for (const item of tickets) {
        if (item.mimeType === 'application/pdf') {
          const result = await renderPdfPages(item.fileUri);
          rendered = [...rendered, ...result];
          all.push(...result);
        } else {
          all.push({ uri: item.fileUri, width: 0, height: 0 });
        }
      }
      if (cancelled) {
        for (const page of rendered) discardPdfRender(page.uri);
        return;
      }
      if (all.length === 0) {
        setFailed(true);
        return;
      }
      setPages(all);
    })();
    return () => {
      cancelled = true;
      // De renders zijn tweede kopieën van je ticket; die laat je niet
      // slingeren in de cache-dir.
      for (const page of rendered) discardPdfRender(page.uri);
    };
  }, [tickets]);

  // ponytail: verwijdert álles wat aan deze avond hangt. Eén bestand uit
  // een stapel van twee pikken vraagt om chrome per ticket in een viewer
  // die juist niets dan ticket wil tonen; delen kan je opnieuw.
  const onDelete = () => {
    Alert.alert(
      tickets.length > 1
        ? t(
            `Alle ${tickets.length} tickets verwijderen?`,
            `Delete all ${tickets.length} tickets?`,
          )
        : t('Ticket verwijderen?', 'Delete ticket?'),
      tickets.length > 1
        ? t(
            'De bestanden worden van dit toestel gewist. Je "Ik ga" blijft staan.',
            'The files are erased from this device. Your "going" stays.',
          )
        : t(
            'Het bestand wordt van dit toestel gewist. Je "Ik ga" blijft staan.',
            'The file is erased from this device. Your "going" stays.',
          ),
      [
        { text: t('Annuleren', 'Cancel'), style: 'cancel' },
        {
          text: t('Verwijderen', 'Delete'),
          style: 'destructive',
          onPress: () => {
            detach(occurrenceId);
            safeBack();
          },
        },
      ],
    );
  };

  return (
    <View onLayout={onLayout} style={[styles.root, { paddingTop: top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => safeBack()} hitSlop={10} style={styles.close}>
          <Ionicons name="close" size={22} color={palette.noir} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {ticket?.eventTitle ?? t('Je ticket', 'Your ticket')}
        </Text>
        <Pressable onPress={onDelete} hitSlop={10} style={styles.close}>
          <Ionicons name="trash-outline" size={20} color={palette.noir} />
        </Pressable>
      </View>

      {!ticket ? (
        <Text style={styles.note}>
          {t('Dit ticket is er niet meer.', 'This ticket is gone.')}
        </Text>
      ) : pages.length > 0 ? (
        <View style={styles.ticket}>
          <ZoomableImages
            pages={pages.map((p) => ({
              uri: p.uri,
              width: p.width || null,
              height: p.height || null,
            }))}
          />
        </View>
      ) : failed ? (
        <Text style={styles.note}>
          {t(
            'Kon dit bestand niet openen. Het staat nog wel op je toestel.',
            'Could not open this file. It is still on your device.',
          )}
        </Text>
      ) : (
        <View style={styles.loading}>
          <SpinningCross size={24} color={palette.noir} />
        </View>
      )}

      <Text style={[styles.note, { paddingBottom: insets.bottom + 12 }]}>
        {tickets.some((x) => x.barcodeTypes.length > 0)
          ? t(
              'Houd de code voor de scanner. Zet je helderheid hoog.',
              'Hold the code up to the scanner. Turn your brightness up.',
            )
          : t('Alleen op dit toestel bewaard.', 'Stored on this device only.')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // Hardcoded wit: dit scherm volgt bewust niet de nacht/dag-modus.
  root: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  close: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontFamily: fontFamily.bold,
    fontSize: 17,
    letterSpacing: -0.34,
    textAlign: 'center',
    color: palette.noir,
  },
  // De viewer brengt z'n eigen (zwarte) vlak mee: op een donkere
  // ondergrond leest een gescande code beter, en het scheelt de scanner
  // een rand wit eromheen.
  ticket: { flex: 1, width: '100%', overflow: 'hidden' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  note: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: 24,
    paddingTop: 12,
    color: '#6b6b70',
  },
});
