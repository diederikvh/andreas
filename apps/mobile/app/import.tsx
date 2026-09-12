import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, SlideInRight } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SpinningCross } from '@/components/SpinningCross';
import { ZoomableImages } from '@/components/ZoomableImages';
import { dowMixed, eventStillUrl, monthShort } from '@/lib/eventDisplay';
import { useLocale, useT, type Locale } from '@/lib/i18n';
import { detectBarcodeTypes } from '@/lib/importBarcode';
import {
  applyMemory,
  learnFromPick,
  logicalDay,
  matchEvent,
  type MatchCandidate,
  type MatchResult,
  type ScoredCandidate,
} from '@/lib/importMatch';
import { extractEventDraft, type EventDraft } from '@/lib/importMetadata';
import { isMatchable, toServerMetadata } from '@/lib/importPayload';
import {
  detectTicket,
  suggestedIntent,
  type Intent,
  type TicketVerdict,
} from '@/lib/importTicket';
import {
  EMPTY_OCR,
  maxLineHeight,
  recognizeImageText,
  type OcrResult,
} from '@/lib/importOcr';
import {
  discardPdfRender,
  renderPdfPage,
  renderPdfPages,
  type PdfRender,
} from '@/lib/importPdf';
import { safeBack } from '@/lib/navigation';
import { useSheetTop } from '@/lib/sheetInset';
import {
  shareFileUris,
  usePendingShare,
  type PendingShare,
} from '@/lib/pendingShare';
import {
  useEvent,
  useMyGoing,
  useToggleGoing,
  useToggleSave,
  useVenues,
} from '@/lib/queries';
import { useSession } from '@/lib/authClient';
import {
  matchPendingEvents,
  search,
  setPendingGoing,
  submitUnknownEvent,
  type PendingEvent,
} from '@/lib/api';
import * as Haptics from 'expo-haptics';
import { useMode, useRoles } from '@/store/mode';
import { useImportLearnings } from '@/store/importLearnings';
import { useTicketFor, useTickets, useTicketsFor } from '@/store/tickets';
import { fontFamily, palette } from '@/theme/tokens';
import { TONE, pendingTone } from '@/theme/tones';

/**
 * Importscherm — fase 1 van "Share naar Andreas".
 *
 * Toont wát er gedeeld is: type, preview, bestandsnaam of URL. Bij een
 * afbeelding of PDF draait daarna de lokale herkenning (fase 2) —
 * barcodes en OCR-tekstblokken. Metadata eruit halen en matchen met een bestaand
 * event is fase 3 en 4 en hangt onder dezelfde payload.
 *
 * Werkt zonder account — alles staat lokaal, er gaat niets naar de API.
 * De regel onderaan zegt dat ook tegen de gebruiker: bij een ticket wil je
 * niet hoeven raden of Andreas het heeft geüpload.
 */
export default function ImportScreen() {
  const roles = useRoles();
  const mode = useMode();
  const insets = useSafeAreaInsets();
  const isNacht = mode === 'nacht';
  const t = useT();

  const pending = usePendingShare((s) => s.pending);
  const hydrated = usePendingShare((s) => s.hydrated);
  const clearPending = usePendingShare((s) => s.clearPending);

  // Twee schermen, geen stapel blokken: kiezen wát het is, en daarna wat
  // je ermee wil. De tweede schuift over de eerste heen en de knop
  // onderaan gaat terug.
  const { top: headerTop, onLayout: onRootLayout } = useSheetTop(8);

  const [step, setStep] = useState<'choose' | 'act'>('choose');
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [selfAdd, setSelfAdd] = useState(false);
  // Staat hier en niet in SharePreview omdat de knop onderaan het moet
  // weten: zodra het gedaan is valt er niets meer terug te gaan.
  const [acted, setActed] = useState(false);

  const toStep2 = (picked: string | null) => {
    Haptics.selectionAsync();
    setPickedId(picked);
    setSelfAdd(picked === null);
    setStep('act');
  };
  const backToStep1 = () => {
    setPickedId(null);
    setSelfAdd(false);
    setActed(false);
    setStep('choose');
  };

  const onClose = () => {
    clearPending();
    safeBack();
  };

  // Wegvegen doet hetzelfde als op Sluiten tikken. Het paneel naar
  // beneden trekken in plaats van de knop pakken mag geen bestanden
  // laten liggen. Een ticket dat al aan een avond hangt blijft staan:
  // daar waakt `isTicketFile` in `clearPending` over.
  useEffect(() => () => usePendingShare.getState().clearPending(), []);

  // Sta je bovenaan stil, dan mag de scrollview niet veren: alleen dán
  // geeft hij een sleep naar beneden door aan iOS en volgt het paneel je
  // vinger. Tijdens het scrollen zelf veert hij gewoon — dat elastiek is
  // waar het scrollen z'n gevoel aan ontleent, en dat willen we houden.
  // Vandaar: bij de eerste beweging meteen weer aan, en pas als hij
  // bovenaan tot stilstand is gekomen weer uit.
  const [atTop, setAtTop] = useState(true);
  const settle = (y: number) => setAtTop(y <= 2);

  // Op stap 2 met een gekozen event is de foto de kop: geen bovenmarge.
  const overHero = step === 'act' && !selfAdd;

  // Typen in het formulier: de balk onderaan schuift boven het keyboard.
  //
  // Hier zat eerst een KeyboardAvoidingView. Die tilde de balk netjes op,
  // maar dáárdoor overlapte het keyboard de scrollview niet meer — en dan
  // doet `automaticallyAdjustKeyboardInsets` niets, dus scrolde het veld
  // waarin je typt niet in beeld. Precies de valkuil die in CLAUDE.md
  // staat. Nu tillen we alleen de balk zelf op, met de gemeten
  // keyboardhoogte, en laat de scrollview z'n eigen werk doen.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const keyboardUp = keyboardHeight > 0;
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () =>
      setKeyboardHeight(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // De actie van het onderste balkje. Op het formulier voor zelf
  // toevoegen is dat "Aanmelden": die knop stond in de scroll en zat dus
  // achter het keyboard, terwijl het het enige is wat je daarna nog wil.
  // SharePreview meldt 'm hier aan zodra dat scherm er staat.
  const [dockAction, setDockAction] = useState<{
    label: string;
    disabled: boolean;
    run: () => void;
  } | null>(null);

  return (
    <View
      onLayout={onRootLayout}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      <View style={styles.fill}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          bounces={!atTop}
          onScroll={(e) => {
            if (e.nativeEvent.contentOffset.y > 2 && atTop) setAtTop(false);
          }}
          onScrollEndDrag={(e) => settle(e.nativeEvent.contentOffset.y)}
          onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
          // De dock is een flex-sibling, geen absolute child, dus KAV heeft
          // hier niks te zoeken. Dit houdt het veld waarin je typt zichtbaar.
          automaticallyAdjustKeyboardInsets
          // Bovenmarge zit in de content en niet in een losse View erboven:
          // anders houdt die View een strook vast waar niets doorheen kan
          // scrollen en verdwijnt je afbeelding een centimeter voor de
          // rand. Is het beeld van het event de kop, dan is er geen marge —
          // dat loopt tot tegen de bovenrand.
          contentContainerStyle={{
            paddingTop: overHero ? 0 : headerTop + 12,
            // Terwijl je typt staat de balk óver de content; die hoogte
            // erbij, anders kan het onderste veld er niet vrij van
            // scrollen.
            paddingBottom: insets.bottom + 40 + (keyboardUp ? 76 : 0),
          }}
        >
          {pending ? (
            <SharePreview
              share={pending}
              step={step}
              pickedId={pickedId}
              selfAdd={selfAdd}
              acted={acted}
              onActed={() => setActed(true)}
              onDockAction={setDockAction}
              onPickCandidate={toStep2}
            />
          ) : (
            <View style={styles.waiting}>
              {/* Gehydrateerd zonder payload = de share kwam niet aan of
                was een type dat we niet lezen. Dan liever dit dan een
                spinner die nooit stopt. */}
              {hydrated ? null : (
                <SpinningCross size={28} color={roles.fgMuted} />
              )}
              <Text style={[styles.waitingText, { color: roles.fgMuted }]}>
                {hydrated
                  ? t(
                      'Niets gevonden om te importeren.',
                      'Nothing found to import.',
                    )
                  : t(
                      'Even kijken wat je deelde…',
                      'Checking what you shared…',
                    )}
              </Text>
            </View>
          )}
        </ScrollView>

        <View
          style={[
            styles.dock,
            {
              // Boven het keyboard, niet erachter: de knop die je nodig
              // hebt hoort zichtbaar te blijven terwijl je typt.
              marginBottom: keyboardHeight,
              // Op Android is de systeembalk een rij echte knoppen; dan
              // wil je ruimte tússen onze knop en die van het toestel,
              // niet alleen de inset. Op iOS is het een streepje en zit
              // die lucht al in de inset. Ligt de balk op het keyboard,
              // dan is die ruimte er al.
              paddingBottom: keyboardUp
                ? 10
                : Platform.OS === 'android'
                  ? insets.bottom + 14
                  : Math.max(insets.bottom, 12),
              backgroundColor: roles.bg,
              borderTopColor: roles.bgChip,
            },
          ]}
        >
          <View style={styles.dockRow}>
            {/* Eén knop, twee betekenissen: halverwege stap 2 brengt hij
                je terug naar de keuze, en op stap 1 sluit hij het scherm.
                Ben je klaar, dan is er niets om naar terug te gaan — een
                save draai je hier niet ongedaan — dus dan sluit hij. */}
            <Pressable
              onPress={step === 'act' && !acted ? backToStep1 : onClose}
              style={[
                styles.close,
                dockAction ? styles.closeNarrow : styles.closeWide,
                { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
              ]}
            >
              <Text style={[styles.closeText, { color: roles.fg }]}>
                {step === 'act' && !acted
                  ? t('Terug', 'Back')
                  : t('Sluiten', 'Close')}
              </Text>
            </Pressable>

            {dockAction ? (
              <Pressable
                onPress={dockAction.run}
                disabled={dockAction.disabled}
                style={[
                  styles.close,
                  styles.closeWide,
                  {
                    backgroundColor: roles.accent,
                    opacity: dockAction.disabled ? 0.45 : 1,
                  },
                ]}
              >
                <Text style={[styles.closeText, { color: roles.onAccent }]}>
                  {dockAction.label}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>

      {/* Greepje bovenaan. Zelf getekend: UIKit tekent er alleen één bij
          een formSheet, en dat is deze route niet — een formSheet heeft
          een scherm nodig om over te staan en bij een share vanaf een
          koude start is dat er niet, dan blijft het sheet leeg. Slepen
          werkt hier wel: deze View vangt geen touches, dus de sleep gaat
          naar de scroll eronder en die geeft 'm door aan het sheet. */}
      {Platform.OS === 'ios' ? (
        <View
          pointerEvents="none"
          style={[
            styles.grabber,
            {
              backgroundColor: overHero
                ? 'rgba(255,255,255,0.6)'
                : isNacht
                  ? 'rgba(242,242,239,0.32)'
                  : 'rgba(26,26,26,0.2)',
            },
          ]}
        />
      ) : null}
    </View>
  );
}

/**
 * Het sheet verlaten naar een echte pagina.
 *
 * Een `push` vanuit dit scherm opent de bestemming *in* de drawer — je
 * plannen of een eventpagina in een halfhoog venster met onze dock
 * eronder. `dismissTo` sluit het sheet eerst en navigeert daarna, dus je
 * komt gewoon in de app uit.
 *
 * De pending share gaat mee weg; `keepFile` omdat een gekoppeld ticket
 * inmiddels eigendom van de ticketstore is.
 */
function leaveTo(href: string): void {
  usePendingShare.getState().clearPending({ keepFile: true });
  if (router.canDismiss()) router.dismissTo(href as never);
  else router.replace(href as never);
}

const KIND_META: Record<
  PendingShare['kind'],
  { icon: keyof typeof Ionicons.glyphMap; nl: string; en: string }
> = {
  url: { icon: 'link-outline', nl: 'Link', en: 'Link' },
  text: { icon: 'text-outline', nl: 'Tekst', en: 'Text' },
  image: { icon: 'image-outline', nl: 'Afbeelding', en: 'Image' },
  pdf: { icon: 'document-text-outline', nl: 'PDF', en: 'PDF' },
  file: { icon: 'document-outline', nl: 'Bestand', en: 'File' },
};

/** Wat er aangemeld of aangevinkt is, genoeg om het op de klaar-melding
    te kunnen laten zien: je hebt die velden zelf ingevuld, dan moet je ze
    ook terugzien. */
type SubmittedEvent = {
  id: string;
  going: boolean;
  ticket: boolean;
  title: string | null;
  venue: string | null;
  date: string | null;
  time: string | null;
  city: string | null;
};

type ScanState = {
  status: 'idle' | 'busy' | 'done';
  barcodeTypes: string[];
  ocr: OcrResult;
  error: string | null;
};

const IDLE_SCAN: ScanState = {
  status: 'idle',
  barcodeTypes: [],
  ocr: EMPTY_OCR,
  error: null,
};

function SharePreview({
  share,
  step,
  pickedId,
  selfAdd,
  acted,
  onActed,
  onDockAction,
  onPickCandidate,
}: {
  share: PendingShare;
  step: 'choose' | 'act';
  pickedId: string | null;
  selfAdd: boolean;
  acted: boolean;
  onActed: () => void;
  /** Meldt de hoofdactie aan bij de balk onderaan. `null` = alleen de
      terug/sluit-knop. */
  onDockAction: (
    action: { label: string; disabled: boolean; run: () => void } | null,
  ) => void;
  /** `null` = "geen van deze" → zelf toevoegen. */
  onPickCandidate: (id: string | null) => void;
}) {
  const roles = useRoles();
  const locale = useLocale();
  const t = useT();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const [imageFailed, setImageFailed] = useState(false);
  const [scan, setScan] = useState<ScanState>(IDLE_SCAN);
  // Pagina 1 komt uit de herkenning en dient meteen als preview-thumbnail;
  // de rest renderen we pas als iemand fullscreen kijkt.
  const [pdfCover, setPdfCover] = useState<PdfRender | null>(null);
  const [pdfPages, setPdfPages] = useState<PdfRender[]>([]);

  // Afbeeldingen gaan direct de herkenning in; een PDF wordt eerst
  // lokaal naar een afbeelding gerenderd, want zowel OCR als
  // barcode-detectie werken op pixels.
  const scannable =
    share.kind === 'image' || share.kind === 'pdf' ? share.fileUri : null;
  const isPdf = share.kind === 'pdf';

  useEffect(() => {
    if (!scannable) return;
    let cancelled = false;
    setScan({ ...IDLE_SCAN, status: 'busy' });
    void (async () => {
      const render = isPdf ? await renderPdfPage(scannable) : null;
      if (cancelled) return;
      if (isPdf && !render) {
        setScan({
          ...IDLE_SCAN,
          status: 'done',
          error: 'pdf-render-mislukt',
        });
        return;
      }
      const scanUri = render?.uri ?? scannable;

      // Parallel: de barcode-scan is snel, OCR duurt een seconde. Geen
      // reden om op elkaar te wachten.
      const [barcodeTypes, ocr] = await Promise.all([
        detectBarcodeTypes(scanUri),
        recognizeImageText(scanUri).catch((e: unknown) => ({
          // Meest waarschijnlijke oorzaak: native module niet gelinkt
          // (oude build). Zichtbaar maken, niet stil falen.
          error: e instanceof Error ? e.message : String(e),
        })),
      ]);
      // De render blijft staan zolang dit scherm open is: hij dient ook
      // als preview-thumbnail van de PDF. Opruimen gebeurt in de cleanup
      // hieronder, niet hier.
      if (render) setPdfCover(render);
      if (cancelled) return;
      const failed = 'error' in ocr;
      setScan({
        status: 'done',
        barcodeTypes,
        ocr: failed ? EMPTY_OCR : ocr,
        error: failed ? ocr.error : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [scannable, isPdf]);

  // Gerenderde PDF-pagina's opruimen zodra dit scherm weg is. Twee bronnen:
  // de cover (pagina 1, uit de herkenning) en alle pagina's die we voor het
  // volledige scherm hebben gerenderd.
  useEffect(
    () => () => {
      if (pdfCover) discardPdfRender(pdfCover.uri);
      for (const page of pdfPages) discardPdfRender(page.uri);
    },
    [pdfCover, pdfPages],
  );

  // Venuelijst voor de naam-match. Publieke GET die de app toch al cachet;
  // er gaat niets van de gedeelde content naar de server.
  const { data: venues } = useVenues({});
  const venueNames = useMemo(() => (venues ?? []).map((v) => v.name), [venues]);

  // Ticket of poster? Bepaalt welke intentie we voorstellen. Bij een link
  // of losse tekst is er geen OCR, dan is de gedeelde tekst de input.
  const verdict: TicketVerdict = useMemo(
    () =>
      detectTicket({
        text: scan.ocr.fullText || share.text || share.title || '',
        barcodeTypes: scan.barcodeTypes,
        kind: share.kind,
      }),
    [scan.ocr.fullText, scan.barcodeTypes, share.kind, share.text, share.title],
  );

  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [edited, setEdited] = useState(false);

  // Wat we van eerdere handmatige koppelingen leerden. Een kaartje van een
  // zaal die je al eens zelf hebt aangewezen leest daardoor beter.
  const venueMemory = useImportLearnings((s) => s.venues);
  const remember = useImportLearnings((s) => s.remember);

  // Opnieuw extraheren zodra de OCR klaar is of de venuelijst alsnog
  // binnenkomt — maar niet meer nadat de gebruiker zelf iets heeft
  // aangepast. `useVenues` refetcht op focus en geeft dan een nieuwe
  // array-reference; zonder die `edited`-grens zou een refetch je
  // correcties overschrijven.
  useEffect(() => {
    if (edited) return;
    if (scan.status !== 'done' || scan.ocr.blocks.length === 0) return;
    // `isTicket` verandert hoe de titel gekozen wordt: op een kaartje is
    // het grootste element het logo van de zaal, niet de naam van wat je
    // gaat zien.
    setDraft(
      applyMemory(
        extractEventDraft(scan.ocr, {
          venueNames,
          isTicket: verdict.isTicket,
          // Wat de provider in de bestandsnaam tikte is betrouwbaarder
          // dan wat wij van een logo maken.
          fileName: share.fileName,
        }),
        venueMemory,
      ),
    );
  }, [scan, venueNames, edited, verdict.isTicket, venueMemory, share.fileName]);

  const updateDraft = (patch: Partial<EventDraft>) => {
    setEdited(true);
    setDraft((prev) => ({ ...(prev ?? EMPTY_DRAFT_STATE), ...patch }));
  };

  // Alles wat naar de server gaat, gaat eerst door de whitelist. Dit is
  // de eerste en enige call in deze flow, en `q` is bewust alleen de
  // titel: geen datum, geen bestandsnaam, geen OCR-dump in een query.
  const safe = useMemo(() => toServerMetadata(draft ?? {}), [draft]);
  const query = safe.title ?? safe.artists[0] ?? safe.venue ?? '';
  const expectsMatch = query.length > 1 && isMatchable(safe);
  const { data: matches, isFetching: matching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => search(query),
    enabled: expectsMatch,
    staleTime: 60_000,
    // Pas je de titel aan, dan blijft de vorige lijst staan tot de nieuwe
    // binnen is. Anders knippert de lijst weg bij elke toetsaanslag.
    placeholderData: keepPreviousData,
  });

  // Heeft iemand anders dit al aangemeld? Dan moet je daaraan kunnen
  // hangen in plaats van een tweede aanmelding te maken. Zelfde gate als
  // de event-zoekopdracht, dus geen extra request bij te weinig gegevens.
  const { data: pendingMatches } = useQuery({
    queryKey: ['pending-match', safe.title, safe.venue, safe.date],
    queryFn: () =>
      matchPendingEvents({
        title: safe.title,
        venue: safe.venue,
        date: safe.date,
      }),
    enabled: expectsMatch,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const [chosenIntent, setChosenIntent] = useState<Intent | null>(null);
  // Het event dat je zelf opzocht toen wij het niet vonden.
  const [manual, setManual] = useState<MatchCandidate | null>(null);

  const match: MatchResult | null = useMemo(() => {
    if (!matches) return null;
    const candidates: MatchCandidate[] = matches.events.map((e) => ({
      id: e.id,
      title: e.title,
      venueName: e.nextOccurrenceVenue?.name ?? e.venue.name,
      startsAt: e.startsAt,
      imageUrl: e.posterUrl ?? e.imageUrl ?? e.venue.imageUrl ?? null,
    }));
    return matchEvent(safe, candidates);
  }, [matches, safe]);

  // Welke kandidaat is het? Bij hoge confidence de bovenste, anders degene
  // die de gebruiker aantikt. Dat aantikken navigeert dus níet meteen weg:
  // zonder gekozen event is er geen occurrence, en zonder occurrence kan je
  // geen intentie zetten en geen ticket koppelen. Een ticket dat maar 80%
  // matcht moet je net zo goed kunnen bewaren.
  // Pas fetchen als de gebruiker bevestigd heeft welk event het is: geen
  // verspilde request bij twijfel.
  const bestId = pickedId ?? '';
  const { data: detail } = useEvent(bestId);
  const occurrenceId = useMemo(() => {
    if (!detail) return null;
    const onDraftDate = safe.date
      ? detail.occurrences.find((o) => logicalDay(o.startsAt) === safe.date)
      : null;
    return (onDraftDate ?? detail.occurrences[0])?.id ?? null;
  }, [detail, safe.date]);

  const meta = KIND_META[share.kind];
  const cardBg = isNacht ? palette.noir2 : palette.paper2;
  const heroUrl = detail ? eventStillUrl(detail) : null;
  // Deelde je meer dan één bestand, dan is het aantal het enige dat je
  // hier wil lezen: één naam noemen suggereert dat de rest niet meekomt.
  const sharedCount = shareFileUris(share).length;
  const sourceLabel =
    sharedCount > 1
      ? t(`${sharedCount} bestanden`, `${sharedCount} files`)
      : (share.title ??
        (share.kind === 'url'
          ? share.url
          : share.kind === 'text'
            ? share.text
            : share.kind === 'image'
              ? null
              : share.fileName));
  const thumbUri =
    share.kind === 'image' ? share.fileUri : (pdfCover?.uri ?? null);
  const showThumb = Boolean(thumbUri) && !imageFailed;

  // ── De flow ───────────────────────────────────────────────────────────
  // Drie stappen in plaats van één scherm met alles erop. De eerste versie
  // toonde tekstblokken met pixelhoogtes, bestandsgroottes, matchpercentages
  // en zes invulvelden tegelijk — dat is het gereedschap waarmee ík de
  // herkenning heb getuned, geen antwoord op de enige vraag die de
  // gebruiker heeft: "is dit het, en wil ik erheen?"
  //
  //   1. klopt dit?   → welk event is dit
  //   2. wat wil je?  → ♡ of ✓, en of dit je ticket is
  //   3. klaar        → waar het nu staat
  //
  // Alles technisch zit achter een deur: de velden achter "details
  // aanpassen", de ruwe herkenning achter een dev-only paneel onderaan.
  const [fullscreen, setFullscreen] = useState(false);

  // Alle pagina's pas renderen als iemand ook echt gaat kijken.
  const openFullscreen = async () => {
    setFullscreen(true);
    if (!isPdf || !share.fileUri || pdfPages.length > 0) return;
    setPdfPages(await renderPdfPages(share.fileUri));
  };
  const [submitState, setSubmitState] = useState<
    'idle' | 'sending' | 'done' | 'failed'
  >('idle');
  const [submitted, setSubmitted] = useState<SubmittedEvent | null>(null);
  // Bij een event dat Andreas niet kent is een bestand er bijna altijd
  // omdát je een ticket hebt — dat is de reden dat je het formulier
  // invult. Dus standaard aan, en je kan 'm uitzetten. Andreas' oordeel
  // ("dit is geen ticket") beslist dit niet: bij een onbekend event is
  // de herkenning het minst betrouwbaar en jij het meest zeker.
  const [keepOwnTicket, setKeepOwnTicket] = useState<boolean | null>(null);
  const willKeepOwn = keepOwnTicket ?? Boolean(share.fileUri);
  const qc = useQueryClient();

  /**
   * Aanmelden stuurt exact wat de whitelist doorlaat — dezelfde `safe` die
   * de matcher gebruikte, geen ruwe OCR. Zie fase 1.7.
   *
   * Daarna staat het meteen in je plannen (de server zet de going-rij
   * erbij) en hangt je ticket eraan. Wachten op een review is de verkeerde
   * beloning voor iemand die zelf het formulier invulde.
   */
  const submitUnknown = async () => {
    if (!isMatchable(safe)) return;
    setSubmitState('sending');
    try {
      const res = await submitUnknownEvent({ ...safe, source: 'share' });
      const keepTicket = Boolean(share.fileUri) && willKeepOwn;
      if (keepTicket) attachToPending(res.id);
      setSubmitted({
        id: res.id,
        going: res.going,
        ticket: keepTicket,
        title: safe.title ?? safe.artists[0] ?? null,
        venue: safe.venue,
        date: safe.date,
        time: safe.time,
        city: safe.city,
      });
      void qc.invalidateQueries({ queryKey: ['pending-events'] });
      setSubmitState('done');
      onActed();
    } catch {
      setSubmitState('failed');
    }
  };

  /**
   * Ga ook naar een aanmelding van iemand anders.
   *
   * Geen tussenstap: het event is herkend en je ticket hoeft niet nog een
   * keer bevestigd te worden. Wel eerst naar stap 2 — daar staat de
   * uitkomst, en op stap 1 zou je op een knop tikken waar niets van te
   * zien is.
   */
  const joinPending = async (pending: PendingEvent) => {
    onPickCandidate(null);
    setSubmitState('sending');
    try {
      await setPendingGoing(pending.id, true);
      const keepTicket = Boolean(share.fileUri) && willKeepOwn;
      if (keepTicket) attachToPending(pending.id);
      setSubmitted({
        id: pending.id,
        going: true,
        ticket: keepTicket,
        title: pending.title ?? pending.artists[0] ?? null,
        venue: pending.venue,
        date: pending.date,
        time: pending.time,
        city: pending.city,
      });
      void qc.invalidateQueries({ queryKey: ['pending-events'] });
      setSubmitState('done');
      onActed();
    } catch {
      setSubmitState('failed');
    }
  };

  /**
   * Zelf opgezocht en aangewezen.
   *
   * Hier leren we van: lazen we de grote regel op een kaartje verkeerd,
   * dan onthouden we bij welke zaal die regel hoort. Alleen bij een
   * ticket — op een affiche is die regel meestal wél de titel, en kies je
   * een ander event omdat het programma anders heet.
   */
  const pickSearched = (candidate: MatchCandidate) => {
    if (verdict.isTicket && draft) {
      const lesson = learnFromPick(draft, candidate);
      if (lesson) remember(lesson.key, lesson.venue);
    }
    setManual(candidate);
    onPickCandidate(candidate.id);
  };

  /** De ticketstore sleutelt op een string; een `sub-…`-id werkt daar net
      zo goed als een occurrence-id. Zodra de aanmelding een echt event
      wordt verhuist het plan mee — het ticket blijft dan hier hangen en
      dat is een los puntje voor later (fase 6.2 in het werkdocument). */
  function attachToPending(id: string) {
    const files = share.extraFiles ?? [];
    const all = share.fileUri
      ? [
          {
            fileUri: share.fileUri,
            fileName: share.fileName ?? null,
            mimeType: share.mimeType ?? null,
          },
          ...files,
        ]
      : files;
    for (const file of all) {
      useTickets.getState().attach({
        occurrenceId: id,
        eventId: id,
        eventTitle: safe.title ?? null,
        fileUri: file.fileUri,
        fileName: file.fileName,
        mimeType: file.mimeType,
        barcodeTypes: verdict.signals.includes('barcode') ? ['qr'] : [],
        addedAt: Date.now(),
      });
    }
  }

  // Op het formulier voor zelf toevoegen is "Aanmelden" de hoofdactie, en
  // die hoort in de balk onderaan te staan: daar blijft hij zichtbaar met
  // een open keyboard. In de scroll zat hij erachter.
  const canSubmit = isMatchable(safe);
  useEffect(() => {
    if (!selfAdd || step !== 'act' || submitState === 'done') {
      onDockAction(null);
      return;
    }
    onDockAction({
      label:
        submitState === 'sending'
          ? t('Aanmelden…', 'Submitting…')
          : t('Aanmelden', 'Submit'),
      disabled: !canSubmit || submitState === 'sending',
      run: submitUnknown,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfAdd, step, submitState, canSubmit, locale]);

  // De balk hoort bij dit scherm: laat 'm niet achter als we weg zijn.
  useEffect(() => () => onDockAction(null), [onDockAction]);

  const storedTicket = useTicketFor(occurrenceId);
  const storedTicketCount = useTicketsFor(occurrenceId).length;
  // Welke knop bovenaan staat en aan is: de knop die bij de herkenning
  // hoort. Zit er een ticket bij — of hangt er al één aan deze avond —
  // dan ga je. Een poster zonder code is een plan voor later.
  const intent =
    chosenIntent ??
    (storedTicket ? 'going' : suggestedIntent(verdict, share.kind));
  // Zelf gezocht en aangewezen? Dan staat dat event niet in `match.ranked`
  // — daar zit alleen wat wij van de herkenning maakten. Zonder deze
  // terugval draait stap 2 eeuwig z'n spinner.
  const chosen: ScoredCandidate | null = useMemo(() => {
    const scored = match?.ranked.find((r) => r.candidate.id === bestId);
    if (scored) return scored;
    if (!manual || manual.id !== bestId) return null;
    return {
      candidate: manual,
      score: 1,
      parts: { title: null, venue: null, date: null, time: null },
      dateMatches: !safe.date || logicalDay(manual.startsAt) === safe.date,
    };
  }, [match, bestId, manual, safe.date]);
  const chosenWhen = useMemo(() => {
    if (!chosen) return '';
    const when = new Date(chosen.candidate.startsAt);
    if (Number.isNaN(when.getTime())) return '';
    return `${dowMixed(when.getDay(), locale)} ${when.getDate()} ${monthShort(
      when.getMonth(),
      locale,
    )}`;
  }, [chosen, locale]);

  // Eén toestand voor de hele keten, anders klappert het scherm. Tussen
  // "OCR klaar" en "zoekopdracht gestart" zit minstens één render waarin
  // er geen kandidaten zijn — zonder deze afdekking flitst daar
  // "Dit kent Andreas nog niet" voorbij, om meteen daarna alsnog een
  // lijst te tonen. Dus: we checken tot we een antwoord hébben.
  const scanning = Boolean(scannable) && scan.status !== 'done';
  const extracting =
    Boolean(scannable) &&
    scan.status === 'done' &&
    !draft &&
    scan.ocr.blocks.length > 0;
  const searching =
    expectsMatch &&
    (matching || matches === undefined || pendingMatches === undefined);
  const busy = scanning || extracting || searching;

  return (
    <View style={styles.body}>
      {step === 'choose' ? (
        <Animated.View entering={FadeIn.duration(140)} style={{ gap: 12 }}>
          {/* Wat je gaf: groot en gecentreerd, want dit is waar je naar
              kijkt om te bepalen of de herkenning klopt. Tikken maakt 'm
              fullscreen. */}
          <View style={styles.sourceBlock}>
            {showThumb ? (
              <Pressable onPress={openFullscreen}>
                <Image
                  source={{ uri: thumbUri! }}
                  style={[styles.sourcePreview, { backgroundColor: cardBg }]}
                  contentFit="contain"
                  onError={() => setImageFailed(true)}
                />
              </Pressable>
            ) : (
              <View
                style={[
                  styles.sourcePreview,
                  styles.sourceIcon,
                  { backgroundColor: cardBg },
                ]}
              >
                <Ionicons name={meta.icon} size={34} color={roles.fgMuted} />
              </View>
            )}
            {sourceLabel ? (
              <Text
                numberOfLines={2}
                style={[styles.sourceName, { color: roles.fgMuted }]}
              >
                {sourceLabel}
              </Text>
            ) : null}
          </View>

          <View style={[styles.divider, { backgroundColor: roles.bgChip }]} />

          <ChooseStep
            busy={busy}
            match={match}
            draftTitle={draft?.title ?? null}
            draftDate={safe.date}
            hasFile={Boolean(share.fileUri)}
            pendingMatches={pendingMatches ?? []}
            onJoinPending={joinPending}
            onPick={onPickCandidate}
            onPickSearched={pickSearched}
          />
        </Animated.View>
      ) : (
        <Animated.View
          entering={SlideInRight.duration(220)}
          style={{ gap: 12 }}
        >
          {selfAdd ? (
            <SelfAddStep
              draft={draft}
              canSubmit={isMatchable(safe)}
              fileCount={shareFileUris(share).length}
              keepTicket={willKeepOwn}
              onToggleKeepTicket={() => setKeepOwnTicket(!willKeepOwn)}
              submitState={submitState}
              submitted={submitted}
              onSubmitUnknown={submitUnknown}
              onChangeDraft={updateDraft}
            />
          ) : chosen ? (
            <>
              {/* Waar je bent, niet wat je kan kiezen: geen kaart, geen
                  rand, geen vinkje. Dezelfde opbouw als scherm 1 — info,
                  streep, dan pas de acties. Zo houden de knoppen het
                  zwaarste gewicht op dit scherm.

                  Kennen we het event, dan kennen we ook z'n beeld. Dat is
                  de kop van dit scherm: het bewijs dát we het kennen, nog
                  voor je de titel leest. Komt mee met `detail`, dus met
                  een fade in plaats van een klap. */}
              {/* Dezelfde kop als overal: foto vullend, verticale
                  gradient eroverheen, titel in display-type linksonder.
                  Dat is het patroon van de event-detail hero en van de
                  featured-kaart op Vandaag — inclusief de gradient-stops.
                  Geen foto? Dan blijft de kaart staan op accent (dag) of
                  noir2 (nacht), precies zoals die featured-kaart doet. */}
              <View
                style={[
                  styles.chosenHero,
                  { backgroundColor: isNacht ? palette.noir2 : roles.accent },
                ]}
              >
                {heroUrl ? (
                  <Image
                    source={{ uri: heroUrl }}
                    style={StyleSheet.absoluteFill}
                    contentFit="cover"
                    transition={180}
                  />
                ) : null}
                <LinearGradient
                  colors={
                    isNacht
                      ? [
                          'rgba(10,10,11,0)',
                          'rgba(10,10,11,0)',
                          'rgba(10,10,11,0.55)',
                          'rgba(10,10,11,0.85)',
                        ]
                      : [
                          'rgba(0,0,0,0)',
                          'rgba(0,0,0,0)',
                          'rgba(0,0,0,0.45)',
                          'rgba(0,0,0,0.72)',
                        ]
                  }
                  locations={[0, 0.35, 0.7, 1]}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
                <View style={styles.chosenHeroBottom}>
                  <Text
                    style={[
                      styles.chosenTitle,
                      { color: isNacht ? palette.ink : palette.paper3 },
                    ]}
                  >
                    {chosen.candidate.title}
                  </Text>
                  <Text
                    style={[
                      styles.chosenMeta,
                      {
                        color: isNacht
                          ? 'rgba(242,242,239,0.85)'
                          : 'rgba(255,255,255,0.95)',
                      },
                    ]}
                  >
                    {chosen.candidate.venueName}
                    {chosenWhen ? ` · ${chosenWhen}` : ''}
                  </Text>
                </View>
              </View>
              {/* Staat onder de kaart en niet erop: het is een
                  waarschuwing over de match, geen eigenschap van het
                  event. */}
              {chosen.dateMatches ? null : (
                <Text style={[styles.chosenNote, { color: roles.fgMuted }]}>
                  {t(
                    'Let op: andere avond dan op wat je deelde.',
                    'Note: other night than what you shared.',
                  )}
                </Text>
              )}
              {!acted ? (
                <IntentStep
                  candidate={chosen.candidate}
                  share={share}
                  verdict={verdict}
                  intent={intent}
                  onChoose={setChosenIntent}
                  occurrenceId={occurrenceId}
                  onDone={onActed}
                />
              ) : (
                <DoneStep
                  eventId={chosen.candidate.id}
                  ticketCount={storedTicketCount}
                />
              )}
            </>
          ) : (
            <View style={styles.hintRow}>
              <SpinningCross size={16} color={roles.fgMuted} />
            </View>
          )}
        </Animated.View>
      )}

      {__DEV__ ? <DevPanel share={share} scan={scan} draft={draft} /> : null}

      {/* Een RN-Modal en geen absolute View: dit scherm zit zelf in een
          ScrollView, dus een absolute laag daarbinnen dekt de header en de
          dock niet — die bleven er dwars doorheen staan. */}
      <Modal
        visible={fullscreen && (Boolean(thumbUri) || pdfPages.length > 0)}
        animationType="fade"
        presentationStyle="overFullScreen"
        transparent
        onRequestClose={() => setFullscreen(false)}
      >
        {thumbUri || pdfPages.length > 0 ? (
          <ZoomableImages
            pages={
              pdfPages.length > 0
                ? pdfPages.map((p) => ({
                    uri: p.uri,
                    width: p.width,
                    height: p.height,
                  }))
                : [
                    {
                      uri: thumbUri!,
                      width: share.width ?? pdfCover?.width ?? null,
                      height: share.height ?? pdfCover?.height ?? null,
                    },
                  ]
            }
            background={roles.bg}
            onClose={() => setFullscreen(false)}
          />
        ) : null}
      </Modal>
    </View>
  );
}

/** Korte datumregel voor een zelf toegevoegd event. */
function pendingDateLabel(p: PendingEvent, locale: Locale): string | null {
  if (!p.date) return null;
  const d = new Date(`${p.date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
    d.getMonth(),
    locale,
  ).toUpperCase()}`;
  return p.time ? `${day} · ${p.time}` : day;
}

/* ── Scherm 1: welk event is dit? ──────────────────────────────────── */

/**
 * De enige vraag op dit scherm: welk event is dit?
 *
 * Drie uitkomsten, drie verschillende vragen — en in alle drie de gevallen
 * staat de herkenning in gewone taal en niet als percentage. Dat cijfer is
 * interne weging; wat de gebruiker moet weten is of hij moet kiezen of
 * alleen bevestigen.
 *
 * "Geen van deze" is de laatste rij van de lijst, niet een linkje ernaast:
 * de lijst is pas compleet als die mogelijkheid erin staat.
 */
function ChooseStep({
  busy,
  match,
  draftTitle,
  draftDate,
  hasFile,
  pendingMatches,
  onJoinPending,
  onPick,
  onPickSearched,
}: {
  busy: boolean;
  match: MatchResult | null;
  draftTitle: string | null;
  /** Alleen om "andere avond" bij een zoekresultaat te kunnen zetten. */
  draftDate: string | null;
  hasFile: boolean;
  /** Avonden die iemand zelf heeft toegevoegd en die op deze titel of
      venue lijken. Horen in dezelfde lijst als de echte events: voor wie
      kiest is het verschil niet interessant. */
  pendingMatches: PendingEvent[];
  onJoinPending: (pending: PendingEvent) => void;
  onPick: (id: string | null) => void;
  onPickSearched: (candidate: MatchCandidate) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();
  const locale = useLocale();

  if (busy) {
    return (
      <View style={styles.checking}>
        <SpinningCross size={26} color={roles.fgMuted} />
        <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
          {t('Even checken wat dit is…', 'Checking what this is…')}
        </Text>
      </View>
    );
  }

  // Lage confidence telt als "niet gevonden": de featurelijn zegt dat
  // expliciet, en een lijst met drie slechte gokken is erger dan geen lijst.
  const candidates =
    match && (match.level === 'high' || match.level === 'medium')
      ? match.ranked
      : [];

  return (
    <View style={styles.stepBlock}>
      {/* Geen vraag maar een opdracht, en dezelfde bij één of bij drie
          kandidaten: ook met één suggestie kies je nog steeds tussen die
          ene en "geen van deze". Dan hoeft de kop niet te wisselen. */}
      {/* Kop en regel eronder horen bij elkaar, dus die staan dicht op
          elkaar — en daarna pas lucht naar wat je kan kiezen. Eén keer
          zeggen, hier, klein: in de dock stond het groter dan de knop
          ernaast en op scherm 2 zegt de ticketkaart het al. */}
      <View style={{ gap: 4 }}>
        <Text
          style={[styles.stepQuestion, styles.centered, { color: roles.fg }]}
        >
          {/* Een avond die jij (of iemand anders) zelf toevoegde telt
              net zo goed als keuze — dan is de lijst niet leeg. */}
          {candidates.length === 0 && pendingMatches.length === 0
            ? t('Dit kent Andreas nog niet', 'Andreas does not know this yet')
            : t('Selecteer het event', 'Select the event')}
        </Text>
        {hasFile ? (
          <Text style={[styles.privacy, { color: roles.fgMuted }]}>
            {t(
              'Dit bestand blijft op je toestel en wordt niet met Andreas gedeeld.',
              'This file stays on your device and is not shared with Andreas.',
            )}
          </Text>
        ) : null}
      </View>

      {/* Kandidaten en "geen van deze" in één lijst met dezelfde tussenruimte:
          het zijn allemaal keuzes, dus ze horen even ver uit elkaar. */}
      <View style={{ gap: 8, marginTop: 8 }}>
        {candidates.length > 0 ? (
          <OptionList
            candidates={candidates}
            pickedId={null}
            onPick={(id) => onPick(id)}
          />
        ) : pendingMatches.length > 0 ? null : (
          <Text
            style={[styles.stepLead, styles.centered, { color: roles.fgMuted }]}
          >
            {draftTitle
              ? t(
                  `We lazen "${draftTitle}" — meld het aan en we voegen het toe.`,
                  `We read "${draftTitle}" — submit it and we will add it.`,
                )
              : t(
                  'We konden er geen event uit halen. Vul het zelf aan.',
                  'We could not read an event from this. Fill it in yourself.',
                )}
          </Text>
        )}

        {/* Al toegevoegd — door jou of door iemand anders die hetzelfde
            affiche scande. Zelfde rij als een echt event: wie kiest wil
            weten wélke avond het is, niet uit welke tabel hij komt. */}
        {pendingMatches.map((p) => {
          const label = p.title ?? p.artists[0] ?? t('Deze avond', 'This night');
          return (
          <Pressable
            key={p.id}
            onPress={() => onJoinPending(p)}
            style={[
              styles.option,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                borderColor: 'transparent',
              },
            ]}
          >
            {/* Zelf toegevoegd, dus geen beeld: de eerste letter op een
                kleurvlak, dezelfde kleur als deze avond in je plannen
                heeft. */}
            <View
              style={[
                styles.optionThumb,
                styles.optionThumbFill,
                { backgroundColor: TONE[mode][pendingTone(p.id)] },
              ]}
            >
              <Text style={styles.optionLetter}>{label.trim().charAt(0)}</Text>
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[styles.optionTitle, { color: roles.fg }]}>
                {label}
              </Text>
              <Text style={[styles.optionMeta, { color: roles.fgMuted }]}>
                {[p.venue, pendingDateLabel(p, locale)]
                  .filter(Boolean)
                  .join(' · ') || t('Zelf toegevoegd', 'Added by you')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={roles.fgMuted} />
          </Pressable>
          );
        })}

        <Pressable
          onPress={() => onPick(null)}
          style={[
            styles.option,
            {
              backgroundColor: isNacht ? palette.noir2 : palette.paper2,
              borderColor: 'transparent',
            },
          ]}
        >
          {/* Ook hier een vlak, anders springt deze rij uit het ritme.
              Gedempt en niet in het accent: aanmaken is de uitwijk, niet
              het antwoord. */}
          <View
            style={[
              styles.optionThumb,
              styles.optionThumbFill,
              { backgroundColor: roles.bgChip },
            ]}
          >
            <Ionicons name="add" size={26} color={roles.fgMuted} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[styles.optionTitle, { color: roles.fg }]}>
              {t('Event aanmaken', 'Create event')}
            </Text>
            <Text style={[styles.optionMeta, { color: roles.fgMuted }]}>
              {t(
                'Meld dit event aan bij Andreas',
                'Submit this event to Andreas',
              )}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={roles.fgMuted} />
        </Pressable>

        {/* Zelf zoeken staat onder de keuzes en niet ertussen: die rijen
            zijn één groep, en een veld met een andere vorm er middenin
            hakt die doormidden. Onderaan is het wat het is — de uitweg
            als niets hierboven klopt. */}
        <SearchFallback draftDate={draftDate} onPick={onPickSearched} />
      </View>
    </View>
  );
}

/* ── Scherm 2a: zelf toevoegen ───────────────────────────────────────── */

function SelfAddStep({
  draft,
  canSubmit,
  fileCount,
  keepTicket,
  onToggleKeepTicket,
  submitState,
  submitted,
  onSubmitUnknown,
  onChangeDraft,
}: {
  draft: EventDraft | null;
  canSubmit: boolean;
  /** Hoeveel bestanden er met deze share meekwamen. 0 = niets te bewaren. */
  fileCount: number;
  keepTicket: boolean;
  onToggleKeepTicket: () => void;
  submitState: 'idle' | 'sending' | 'done' | 'failed';
  /** Wat er aangemeld is, en wat er daarna mee gebeurde. `null` zolang
      er niets verstuurd is. */
  submitted: SubmittedEvent | null;
  onSubmitUnknown: () => void;
  onChangeDraft: (patch: Partial<EventDraft>) => void;
}) {
  const roles = useRoles();
  const t = useT();
  const locale = useLocale();

  if (submitState === 'sending' && submitted === null) {
    return (
      <View style={styles.checking}>
        <SpinningCross size={26} color={roles.fgMuted} />
      </View>
    );
  }

  if (submitState === 'done') {
    // Eerst wát het is — titel, venue, datum, tijd — en dan wat ermee
    // gebeurde. Dezelfde opbouw als bij een event dat Andreas wél kent,
    // alleen zonder beeld: dat hebben we niet.
    const when = submitted?.date
      ? new Date(`${submitted.date}T12:00:00`)
      : null;
    const meta = [
      submitted?.venue,
      when && !Number.isNaN(when.getTime())
        ? `${dowMixed(when.getDay(), locale)} ${when.getDate()} ${monthShort(
            when.getMonth(),
            locale,
          )}`
        : null,
      submitted?.time,
      submitted?.city,
    ]
      .filter(Boolean)
      .join(' · ');

    return (
      <View style={styles.stepBlock}>
        {submitted?.title || meta ? (
          <View style={styles.chosenBlock}>
            {submitted?.title ? (
              <Text
                style={[
                  styles.chosenTitle,
                  styles.centered,
                  { color: roles.fg },
                ]}
              >
                {submitted.title}
              </Text>
            ) : null}
            {meta ? (
              <Text
                style={[
                  styles.chosenMeta,
                  styles.centered,
                  { color: roles.fgMuted },
                ]}
              >
                {meta}
              </Text>
            ) : null}
            <Text
              style={[
                styles.chosenNote,
                styles.centered,
                { color: roles.fgPlaceholder },
              ]}
            >
              {t('Nog niet bekend bij Andreas', 'Not known to Andreas yet')}
            </Text>
          </View>
        ) : null}

        <View style={styles.doneHead}>
          <Ionicons name="checkmark-circle" size={30} color={roles.accent} />
          <Text
            style={[styles.stepQuestion, styles.centered, { color: roles.fg }]}
          >
            {submitted?.going
              ? t('Staat in je plannen', 'Added to your plans')
              : t('Aangemeld — dank je', 'Submitted — thank you')}
          </Text>
          <Text
            style={[styles.stepLead, styles.centered, { color: roles.fgMuted }]}
          >
            {submitted?.going
              ? t(
                  submitted.ticket
                    ? 'Je ticket hangt eraan. Andreas kijkt er nog naar, dan wordt het een echt event.'
                    : 'Andreas kijkt er nog naar, dan wordt het een echt event.',
                  submitted.ticket
                    ? 'Your ticket is attached. Andreas still has to look at it before it becomes a real event.'
                    : 'Andreas still has to look at it before it becomes a real event.',
                )
              : t(
                  'We kijken ernaar en zetten het in Andreas.',
                  'We will look at it and add it to Andreas.',
                )}
          </Text>
        </View>

        {/* Geen eventpagina om naartoe te gaan — die bestaat pas als een
            mens er een event van maakt. Je plannen is waar het nú staat. */}
        {submitted?.going ? (
          <Pressable
            onPress={() => leaveTo('/going')}
            style={[styles.primaryBtn, { backgroundColor: roles.accent }]}
          >
            <Text style={[styles.primaryBtnText, { color: roles.onAccent }]}>
              {t('Naar je plannen', 'Open your plans')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.stepBlock}>
      <Text style={[styles.stepQuestion, { color: roles.fg }]}>
        {t('Zelf toevoegen', 'Add it yourself')}
      </Text>
      {draft ? <DraftFields draft={draft} onChange={onChangeDraft} /> : null}

      {/* Hier gaat het meestal juist om: je vult dit formulier in omdát je
          een kaartje hebt voor iets dat Andreas niet kent. Dus standaard
          aan, en geen herkenning die daar overheen beslist. */}
      {fileCount > 0 ? (
        <TicketKeepCard
          keep={keepTicket}
          onToggle={onToggleKeepTicket}
          title={
            fileCount > 1
              ? t('Dit zijn je tickets', 'These are your tickets')
              : t('Dit is je ticket', 'This is your ticket')
          }
          body={
            keepTicket
              ? t(
                  'We bewaren het bij dit event, alleen op dit toestel. Zo toon je het aan de deur.',
                  'We keep it with this event, on this device only. So you can show it at the door.',
                )
              : t(
                  'We bewaren het niet. Je kan het straks niet vanuit Andreas aan de deur tonen.',
                  'We will not keep it. You will not be able to show it from Andreas at the door.',
                )
          }
        />
      ) : null}

      {/* De knop "Aanmelden" staat in de balk onderaan: daar blijft hij
          zichtbaar terwijl je typt. Hier stond hij in de scroll, en dus
          achter het keyboard precies op het moment dat je 'm zocht. */}
      {submitState === 'failed' ? (
        <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
          {t(
            'Aanmelden lukte niet. Probeer het later nog eens.',
            'Submitting failed. Try again later.',
          )}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Zelf zoeken wanneer de herkenning het niet vond.
 *
 * Stond hier alleen "zelf toevoegen", dan meld je een avond aan die
 * Andreas allang kent en hangt je ticket aan een schaduwkopie. Zoeken is
 * dus geen extra: het is de andere helft van dezelfde vraag. Wat je
 * aanwijst onthouden we — zie `learnFromPick` — zodat het volgende
 * kaartje van diezelfde zaal wél door de herkenning komt.
 */
function SearchFallback({
  draftDate,
  onPick,
}: {
  draftDate: string | null;
  onPick: (candidate: MatchCandidate) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();

  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  // Niet elke toetsaanslag een request; een tel stilte is genoeg.
  useEffect(() => {
    const id = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(id);
  }, [typed]);

  const ready = q.length >= 2;
  const { data, isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => search(q),
    enabled: ready,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  // Zelfde rijen als de kandidaten hierboven: het is dezelfde keuze, dus
  // dezelfde vorm. Score is hier niet aan de orde — jij weet het beter.
  const rows: MatchResult['ranked'] = useMemo(
    () =>
      (data?.events ?? []).slice(0, 6).map((e) => {
        const candidate: MatchCandidate = {
          id: e.id,
          title: e.title,
          venueName: e.nextOccurrenceVenue?.name ?? e.venue.name,
          startsAt: e.startsAt,
          imageUrl: e.posterUrl ?? e.imageUrl ?? e.venue.imageUrl ?? null,
        };
        return {
          candidate,
          score: 1,
          parts: { title: null, venue: null, date: null, time: null },
          dateMatches:
            !draftDate || logicalDay(candidate.startsAt) === draftDate,
        };
      }),
    [data, draftDate],
  );

  return (
    <View style={{ gap: 8 }}>
      <View
        style={[
          styles.searchRow,
          { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
        ]}
      >
        <Ionicons name="search" size={18} color={roles.fgMuted} />
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder={t('Zelf zoeken in Andreas', 'Search Andreas yourself')}
          placeholderTextColor={roles.fgPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[styles.searchInput, { color: roles.fg }]}
        />
        {ready && isFetching ? (
          <SpinningCross size={14} color={roles.fgMuted} />
        ) : null}
      </View>

      {ready && rows.length > 0 ? (
        <OptionList
          candidates={rows}
          pickedId={null}
          onPick={(id) => {
            const hit = rows.find((r) => r.candidate.id === id);
            if (hit) onPick(hit.candidate);
          }}
        />
      ) : null}

      {ready && !isFetching && rows.length === 0 ? (
        <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
          {t(
            'Geen event met die naam gevonden.',
            'No event found by that name.',
          )}
        </Text>
      ) : null}
    </View>
  );
}

function OptionList({
  candidates,
  pickedId,
  onPick,
}: {
  candidates: MatchResult['ranked'];
  pickedId: string | null;
  onPick: (id: string) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();

  if (candidates.length === 0) {
    return (
      <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
        {t('Meer opties zijn er niet.', 'There are no other options.')}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      {candidates.map(({ candidate, dateMatches }) => {
        const when = new Date(candidate.startsAt);
        return (
          <Pressable
            key={candidate.id}
            onPress={() => onPick(candidate.id)}
            style={[
              styles.option,
              {
                backgroundColor: isNacht ? palette.noir2 : palette.paper2,
                borderColor:
                  candidate.id === pickedId ? roles.accent : 'transparent',
              },
            ]}
          >
            {/* Het beeld van het event. Kennen we de avond, dan kennen we
                'm ook aan z'n foto — sneller dan de titel lezen. Geen
                beeld? Dan schuift de tekst gewoon naar links; een lege
                grijze vlek zegt niets. */}
            {candidate.imageUrl ? (
              <Image
                source={{ uri: candidate.imageUrl }}
                style={[
                  styles.optionThumb,
                  { backgroundColor: isNacht ? palette.noir3 : palette.paper3 },
                ]}
                contentFit="cover"
                transition={140}
              />
            ) : null}
            <View style={{ flex: 1, gap: 3 }}>
              <Text
                numberOfLines={2}
                style={[styles.optionTitle, { color: roles.fg }]}
              >
                {candidate.title}
              </Text>
              <Text style={[styles.optionMeta, { color: roles.fgMuted }]}>
                {candidate.venueName}
                {Number.isNaN(when.getTime())
                  ? ''
                  : ` · ${dowMixed(when.getDay(), locale)} ${when.getDate()} ${monthShort(
                      when.getMonth(),
                      locale,
                    )}`}
                {dateMatches ? '' : ` · ${t('andere avond', 'other night')}`}
              </Text>
            </View>
            <Ionicons
              name={
                candidate.id === pickedId
                  ? 'checkmark-circle'
                  : 'chevron-forward'
              }
              size={candidate.id === pickedId ? 19 : 16}
              color={candidate.id === pickedId ? roles.accent : roles.fgMuted}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Stap 2: wat wil je hiermee? ─────────────────────────────────────── */

/**
 * Intentie kiezen, en bij een bestand: is dit je ticket?
 *
 * Die tweede vraag staat hier en niet aan het eind — je beslist vóór het
 * koppelen wat je koppelt. Andreas vult z'n voorstel in, de gebruiker
 * beslist.
 */
function IntentStep({
  candidate,
  share,
  verdict,
  intent,
  onChoose,
  occurrenceId,
  onDone,
}: {
  candidate: MatchCandidate;
  share: PendingShare;
  verdict: TicketVerdict;
  intent: Intent;
  onChoose: (intent: Intent) => void;
  occurrenceId: string | null;
  onDone: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const cardBg = isNacht ? palette.noir2 : palette.paper2;
  const t = useT();
  const { data: session } = useSession();
  const authed = Boolean(session?.user?.id);
  const { data: going } = useMyGoing({ enabled: authed });
  const toggleSave = useToggleSave();
  const toggleGoing = useToggleGoing();

  const fileCount = shareFileUris(share).length;
  const storedTickets = useTicketsFor(occurrenceId);
  const storedTicket = storedTickets[0];
  const [keepAsTicket, setKeepAsTicket] = useState<boolean | null>(null);
  // Er mag er meer dan één bij: met z'n tweeën heb je twee bestanden, en
  // soms stuurt de venue een vervanger. Alleen hetzelfde bestand nog een
  // keer heeft geen zin.
  const attachable =
    Boolean(share.fileUri) && storedTicket?.fileUri !== share.fileUri;
  const willKeep = keepAsTicket ?? verdict.isTicket;
  const isGoing = Boolean(
    occurrenceId && going?.some((g) => g.occurrenceId === occurrenceId),
  );

  const act = (next: Intent) => {
    onChoose(next);
    if (!occurrenceId) return;
    const keepFile = attachable && willKeep && Boolean(share.fileUri);
    // Je gaat hier al. Dan is deze knop geen tuimelschakelaar maar
    // "bewaar dit er ook bij" — anders kon je een tweede ticket alleen
    // toevoegen door eerst je plan af te zeggen.
    if (next === 'going' && isGoing && keepFile) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      attachTicket();
      onDone();
      return;
    }
    // Going uitzetten met een ticket eraan kan niet — dat zou je kaartje
    // meesleuren. Eerst het ticket weg, dan het plan.
    if (next === 'going' && isGoing && storedTicket) {
      Alert.alert(
        t('Je gaat hier al', 'You are already going'),
        t(
          'Je ticket hangt aan "ik ga". Verwijder eerst je ticket als je dit plan wil afzeggen.',
          'Your ticket is attached to "going". Remove your ticket first if you want to cancel this plan.',
        ),
        [
          { text: t('Laat staan', 'Keep it'), style: 'cancel' },
          {
            text: t('Ticket bekijken', 'View ticket'),
            onPress: () => router.push(`/ticket/${occurrenceId}` as never),
          },
        ],
      );
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // `source: 'share'` voedt de discovery-trail. De server kent die waarde
    // pas na migratie 0053; tot dan wordt het stil `null`.
    if (next === 'save') {
      toggleSave.mutate({ occurrenceId, source: 'share' });
      // Ook hier koppelen: de schakelaar belooft dat we het bewaren, en
      // die belofte hangt niet aan wélke van de twee knoppen je kiest.
      if (keepFile) attachTicket();
      onDone();
      return;
    }
    toggleGoing.mutate({ occurrenceId, source: 'share' });
    // Alleen koppelen als de gebruiker heeft gezegd dat dit z'n ticket is.
    if (keepFile) attachTicket();
    onDone();
  };

  // Vanaf hier is de store de eigenaar van het bestand: het opruimen laat
  // het staan (zie `isTicketFile` in store/tickets.ts).
  function attachTicket() {
    if (!occurrenceId) return;
    // Alles uit deze share gaat mee: drie kaartjes uit één aankoop zijn
    // drie bestanden en horen aan dezelfde avond. De codetypes komen uit
    // de herkenning van het eerste bestand — we scannen de rest niet, die
    // hoeft alleen bewaard te worden.
    const files = share.extraFiles ?? [];
    const all = share.fileUri
      ? [
          {
            fileUri: share.fileUri,
            fileName: share.fileName ?? null,
            mimeType: share.mimeType ?? null,
          },
          ...files,
        ]
      : files;
    for (const file of all) {
      useTickets.getState().attach({
        occurrenceId,
        eventId: candidate.id,
        eventTitle: candidate.title,
        fileUri: file.fileUri,
        fileName: file.fileName,
        mimeType: file.mimeType,
        barcodeTypes: verdict.signals.includes('barcode') ? ['qr'] : [],
        addedAt: Date.now(),
      });
    }
  }

  return (
    <View style={styles.stepBlock}>
      {/* De ticket-keuze is geen bijzin: het bepaalt of je straks aan de
          deur iets te tonen hebt. Daarom een eigen blok met een echte
          schakelaar, altijd bedienbaar — ook als Andreas zéker weet dat
          het een ticket is. Zet je 'm uit, dan zeggen we eerlijk wat je
          daarmee opgeeft in plaats van de keuze weg te nemen. */}
      {storedTicket ? (
        <Pressable
          onPress={() =>
            router.push(`/ticket/${storedTicket.occurrenceId}` as never)
          }
          style={[
            // Geen accentrand: dit is informatie, geen keuze. Accent is
            // voor de schakelaar eronder die aan staat — twee gele randen
            // boven elkaar maakt ze allebei minder waard.
            styles.ticketCard,
            { backgroundColor: cardBg, borderColor: 'transparent' },
          ]}
        >
          <View style={styles.ticketCardHead}>
            <Ionicons name="ticket" size={19} color={roles.accent} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[styles.ticketCardTitle, { color: roles.fg }]}>
                {/* Verleden tijd, geen bevestiging: dit hing er al voordat
                    je dit scherm opende. "Je ticket staat hierbij" las
                    alsof het net gebeurd was. */}
                {storedTickets.length > 1
                  ? t(
                      `Je had hier al ${storedTickets.length} tickets`,
                      `You already had ${storedTickets.length} tickets here`,
                    )
                  : t(
                      'Je had hier al een ticket',
                      'You already had a ticket here',
                    )}
              </Text>
              <Text style={[styles.ticketCardBody, { color: roles.fgMuted }]}>
                {t(
                  'Alleen op dit toestel. Tik om te bekijken.',
                  'On this device only. Tap to view.',
                )}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={17} color={roles.fgMuted} />
          </View>
        </Pressable>
      ) : null}
      {attachable ? (
        <TicketKeepCard
          keep={willKeep}
          onToggle={() => setKeepAsTicket(!willKeep)}
          title={
            storedTicket
              ? // In het Nederlands dekt dezelfde vraag enkelvoud en
                // meervoud, in het Engels niet.
                t(
                  'Deze er ook bij?',
                  fileCount > 1 ? 'Keep these too?' : 'Keep this one too?',
                )
              : verdict.isTicket
                ? fileCount > 1
                  ? t('Dit lijken je tickets', 'These look like your tickets')
                  : t('Dit lijkt je ticket', 'This looks like your ticket')
                : fileCount > 1
                  ? t('Bewaren als tickets?', 'Keep as your tickets?')
                  : t('Bewaren als ticket?', 'Keep as your ticket?')
          }
          body={
            willKeep
              ? t(
                  'We bewaren het bij dit event, alleen op dit toestel. Zo toon je het aan de deur.',
                  'We keep it with this event, on this device only. So you can show it at the door.',
                )
              : verdict.isTicket
                ? t(
                    'We bewaren het niet. Je kan het straks niet vanuit Andreas aan de deur tonen.',
                    'We will not keep it. You will not be able to show it from Andreas at the door.',
                  )
                : t(
                    'We bewaren het niet. Je houdt het bestand zelf, Andreas doet er niets mee.',
                    'We will not keep it. You keep the file yourself, Andreas does nothing with it.',
                  )
          }
        />
      ) : null}

      {/* De knop die we verwachten staat bovenaan. Zit er een ticket bij,
          dan is dat "ik ga hierheen"; een poster zonder barcode is een
          plan voor later en dan staat "wil ik heen" boven. Scheelt een
          blik: de bovenste is bijna altijd de goede. De volgorde ligt
          vast zodra dit scherm er staat — `intent` verandert alleen door
          te kiezen, en dan is de stap voorbij. */}
      {(intent === 'going'
        ? (['going', 'save'] as const)
        : (['save', 'going'] as const)
      ).map((option) => (
        <Pressable
          key={option}
          onPress={() => act(option)}
          style={[
            styles.choiceBtn,
            intent === option
              ? { backgroundColor: roles.accent }
              : { backgroundColor: roles.bgChip },
          ]}
        >
          <Ionicons
            name={option === 'going' ? 'checkmark-circle' : 'heart'}
            size={option === 'going' ? 20 : 19}
            color={intent === option ? roles.onAccent : roles.fg}
          />
          <View style={styles.choiceBtnLabel}>
            <Text
              style={[
                styles.choiceBtnText,
                { color: intent === option ? roles.onAccent : roles.fg },
              ]}
            >
              {option === 'going'
                ? t('Ik ga hierheen', "I'm going")
                : t('Wil ik heen', 'Want to go')}
            </Text>
            {/* Wat er met je bestand gebeurt staat op de knop die het
                doet. De schakelaar erboven zegt het al, maar die lees je
                niet meer op het moment dat je drukt — en dit is het enige
                moment waarop het ticket wordt vastgelegd. */}
            {attachable ? (
              <Text
                style={[
                  styles.choiceBtnSub,
                  {
                    color:
                      intent === option
                        ? isNacht
                          ? 'rgba(10,10,11,0.62)'
                          : 'rgba(255,255,255,0.72)'
                        : roles.fgMuted,
                  },
                ]}
              >
                {willKeep
                  ? fileCount > 1
                    ? t(
                        `${fileCount} tickets worden bewaard`,
                        `${fileCount} tickets will be saved`,
                      )
                    : t('Ticket wordt bewaard', 'Ticket will be saved')
                  : fileCount > 1
                    ? t(
                        'Tickets worden niet bewaard',
                        'Tickets will not be saved',
                      )
                    : t(
                        'Ticket wordt niet bewaard',
                        'Ticket will not be saved',
                      )}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * De ticket-keuze. Twee plekken gebruiken 'm: een event dat Andreas kent,
 * en een event dat je zelf toevoegt. De kaart schakelt in z'n geheel —
 * een doelwit van 40×24 is te klein voor de keuze die bepaalt of je aan
 * de deur iets te tonen hebt.
 */
function TicketKeepCard({
  keep,
  title,
  body,
  onToggle,
}: {
  keep: boolean;
  title: string;
  body: string;
  onToggle: () => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const cardBg = isNacht ? palette.noir2 : palette.paper2;

  return (
    <Pressable
      onPress={onToggle}
      style={[
        styles.ticketCard,
        {
          backgroundColor: cardBg,
          borderColor: keep ? roles.accent : 'transparent',
        },
      ]}
    >
      <View style={styles.ticketCardHead}>
        <Ionicons
          name="ticket"
          size={19}
          color={keep ? roles.accent : roles.fgMuted}
        />
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[styles.ticketCardTitle, { color: roles.fg }]}>
            {title}
          </Text>
          <Text style={[styles.ticketCardBody, { color: roles.fgMuted }]}>
            {body}
          </Text>
        </View>
        {/* Niet zelf aantikbaar — de kaart eromheen vangt de tik, zodat
            één gebaar niet twee keer kan omschakelen. */}
        <View pointerEvents="none">
          <Switch
            value={keep}
            trackColor={{ true: roles.accent, false: roles.bgChip }}
            thumbColor={isNacht ? palette.ink : palette.paper3}
          />
        </View>
      </View>
    </Pressable>
  );
}

/* ── Stap 3: klaar ───────────────────────────────────────────────────── */

function DoneStep({
  eventId,
  ticketCount,
}: {
  eventId: string;
  ticketCount: number;
}) {
  const roles = useRoles();
  const t = useT();

  // Eén regel en één knop. Titel en venue staan hierboven al, en een
  // aparte "toon ticket"-knop is een tweede uitgang naar hetzelfde punt:
  // op de eventpagina staat die knop toch. Dus: klaar, en hier is 'm.
  return (
    <View style={styles.stepBlock}>
      <View style={styles.doneHead}>
        <Ionicons name="checkmark-circle" size={30} color={roles.accent} />
        <Text
          style={[styles.stepQuestion, styles.centered, { color: roles.fg }]}
        >
          {ticketCount > 1
            ? t(
                `${ticketCount} tickets staan erbij`,
                `${ticketCount} tickets are saved`,
              )
            : ticketCount === 1
              ? t('Ticket staat erbij', 'Ticket is saved')
              : t('Staat in je plannen', 'Added to your plans')}
        </Text>
      </View>

      <Pressable
        onPress={() => leaveTo(`/event/${eventId}?source=share`)}
        style={[styles.primaryBtn, { backgroundColor: roles.accent }]}
      >
        <Text style={[styles.primaryBtnText, { color: roles.onAccent }]}>
          {t('Naar het event', 'Open the event')}
        </Text>
      </Pressable>
    </View>
  );
}

/* ── Dev-only: de ruwe herkenning ────────────────────────────────────── */

/**
 * Alles wat eerst midden in het scherm stond: bestandsgegevens,
 * tekstblokken met regelhoogtes, de barcode-types en de losse
 * metadatavelden. Onmisbaar om fase 3 te tunen, maar niets voor een
 * gebruiker — dus alleen in dev-builds en dichtgeklapt.
 */
function DevPanel({
  share,
  scan,
  draft,
}: {
  share: PendingShare;
  scan: ScanState;
  draft: EventDraft | null;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const [open, setOpen] = useState(false);

  return (
    <View style={{ marginTop: 10 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6}>
        <Text style={[styles.quietLink, { color: roles.fgPlaceholder }]}>
          {open ? '▾ ' : '▸ '}herkenning (dev)
        </Text>
      </Pressable>
      {open ? (
        <View
          style={[
            styles.card,
            { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
          ]}
        >
          <Text style={[styles.mono, { color: roles.fgMuted }]}>
            {[
              share.mimeType,
              formatSize(share.size),
              share.width && share.height
                ? `${share.width}×${share.height}`
                : null,
              scan.barcodeTypes.length
                ? `code: ${scan.barcodeTypes.join(',')}`
                : 'geen code',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {scan.error ? (
            <Text style={[styles.mono, { color: roles.fgMuted }]}>
              {scan.error}
            </Text>
          ) : null}
          {scan.ocr.blocks.map((b, i) => (
            <Text
              key={i}
              numberOfLines={3}
              style={[styles.mono, { color: roles.fgMuted }]}
            >
              {maxLineHeight(b) > 0
                ? `${Math.round(maxLineHeight(b))}px · `
                : ''}
              {b.text.replace(/\n/g, ' / ')}
            </Text>
          ))}
          {draft ? (
            <Text style={[styles.mono, { color: roles.fgMuted }]}>
              {JSON.stringify(draft)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Bytes → "2,4 MB". Eén decimaal, want preciezer helpt niemand. */
const EMPTY_DRAFT_STATE: EventDraft = {
  title: null,
  artists: [],
  venue: null,
  date: null,
  time: null,
  city: null,
};

/**
 * De velden waarin je een event aanvult of corrigeert.
 *
 * Bewust groot: dit is het enige scherm waar je op een telefoon écht moet
 * typen, en de eerste versie had 15px-invoervakjes van 40 hoog — prima op
 * een desktop-formulier, niet op een toestel dat je met één duim
 * vasthoudt. Nu 17px (de iOS-body-maat) in vakken van 56 hoog, met de
 * titel als grootste veld omdat dat de kop van het event is.
 *
 * Datum en tijd zijn géén tekstvelden: die gebruiken de systeempicker,
 * zodat het op iOS de compacte UIDatePicker is en op Android de bekende
 * dialoog. Een gebruiker hoort "jjjj-mm-dd" nooit te hoeven typen.
 */
function DraftFields({
  draft,
  onChange,
}: {
  draft: EventDraft;
  onChange: (patch: Partial<EventDraft>) => void;
}) {
  const t = useT();
  return (
    <View style={{ gap: 16 }}>
      <DraftField
        label={t('Titel', 'Title')}
        value={draft.title}
        placeholder={t('Naam van het event', 'Name of the event')}
        big
        onChangeText={(title) => onChange({ title: title || null })}
      />
      <DraftField
        label={t('Artiest(en)', 'Artist(s)')}
        value={draft.artists.join(', ')}
        placeholder={t('Wie speelt er', 'Who is playing')}
        onChangeText={(value) =>
          onChange({
            artists: value
              .split(',')
              .map((a) => a.trim())
              .filter((a) => a.length > 0),
          })
        }
      />
      <DraftField
        label={t('Venue', 'Venue')}
        value={draft.venue}
        placeholder={t('Waar is het', 'Where is it')}
        onChangeText={(venue) => onChange({ venue: venue || null })}
      />
      <DateTimeField draft={draft} onChange={onChange} />
      <DraftField
        label={t('Stad', 'City')}
        value={draft.city}
        placeholder="Amsterdam"
        onChangeText={(city) => onChange({ city: city || null })}
      />
    </View>
  );
}

function DraftField({
  label,
  value,
  placeholder,
  big = false,
  onChangeText,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  big?: boolean;
  onChangeText: (value: string) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: roles.fgMuted }]}>{label}</Text>
      <TextInput
        value={value ?? ''}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={roles.fgPlaceholder}
        autoCapitalize="sentences"
        autoCorrect={false}
        style={[
          big ? styles.fieldInputBig : styles.fieldInput,
          {
            color: roles.fg,
            backgroundColor: isNacht ? palette.noir2 : palette.paper2,
          },
        ]}
      />
    </View>
  );
}

/**
 * Datum en tijd via de systeempicker.
 *
 * iOS krijgt de compacte variant inline — dat is dezelfde knop als in
 * Agenda, dus het voelt niet als onze UI maar als de telefoon. Android
 * rendert niets inline; daar opent een tik de systeemdialoog en verdwijnt
 * de picker weer zodra je klaar bent. Vandaar de platformsplitsing: dit is
 * geen stijlkeuze maar hoe de component werkt.
 */
function DateTimeField({
  draft,
  onChange,
}: {
  draft: EventDraft;
  onChange: (patch: Partial<EventDraft>) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState<'date' | 'time' | null>(null);

  const bg = isNacht ? palette.noir2 : palette.paper2;
  // Geen datum gekozen? Dan opent de picker op vanavond — dichter bij de
  // waarheid dan 1 januari 1970.
  const current = useMemo(() => {
    const base = draft.date
      ? new Date(`${draft.date}T${draft.time ?? '20:00'}:00`)
      : new Date();
    return Number.isNaN(base.getTime()) ? new Date() : base;
  }, [draft.date, draft.time]);

  const apply = (picked: Date, which: 'date' | 'time') => {
    if (which === 'date') {
      const y = picked.getFullYear();
      const m = String(picked.getMonth() + 1).padStart(2, '0');
      const d = String(picked.getDate()).padStart(2, '0');
      onChange({ date: `${y}-${m}-${d}` });
      return;
    }
    const hh = String(picked.getHours()).padStart(2, '0');
    const mm = String(picked.getMinutes()).padStart(2, '0');
    onChange({ time: `${hh}:${mm}` });
  };

  const dateLabel = draft.date
    ? `${dowMixed(current.getDay(), locale)} ${current.getDate()} ${monthShort(
        current.getMonth(),
        locale,
      )} ${current.getFullYear()}`
    : t('Kies een datum', 'Pick a date');

  return (
    <View style={styles.fieldRow}>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={[styles.fieldLabel, { color: roles.fgMuted }]}>
          {t('Datum', 'Date')}
        </Text>
        {Platform.OS === 'ios' ? (
          <View style={styles.pickerBoxIos}>
            <DateTimePicker
              value={current}
              mode="date"
              display="compact"
              themeVariant={isNacht ? 'dark' : 'light'}
              onChange={(_, picked) => picked && apply(picked, 'date')}
            />
          </View>
        ) : (
          <Pressable
            onPress={() => setOpen('date')}
            style={[styles.pickerBox, { backgroundColor: bg }]}
          >
            <Text style={[styles.pickerValue, { color: roles.fg }]}>
              {dateLabel}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={{ width: 118, gap: 6 }}>
        <Text style={[styles.fieldLabel, { color: roles.fgMuted }]}>
          {t('Tijd', 'Time')}
        </Text>
        {Platform.OS === 'ios' ? (
          <View style={styles.pickerBoxIos}>
            <DateTimePicker
              value={current}
              mode="time"
              display="compact"
              themeVariant={isNacht ? 'dark' : 'light'}
              onChange={(_, picked) => picked && apply(picked, 'time')}
            />
          </View>
        ) : (
          <Pressable
            onPress={() => setOpen('time')}
            style={[styles.pickerBox, { backgroundColor: bg }]}
          >
            <Text style={[styles.pickerValue, { color: roles.fg }]}>
              {draft.time ?? '--:--'}
            </Text>
          </Pressable>
        )}
      </View>

      {open ? (
        <DateTimePicker
          value={current}
          mode={open}
          onChange={(event, picked) => {
            setOpen(null);
            if (event.type === 'set' && picked) apply(picked, open);
          }}
        />
      ) : null}
    </View>
  );
}

function formatSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toFixed(1).replace('.', ',')} MB`;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { flex: 1 },
  grabber: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 999,
  },
  body: { paddingHorizontal: 22, paddingTop: 8, gap: 12 },
  card: { padding: 14, borderRadius: 12, gap: 6 },
  field: { gap: 6 },
  sourceBlock: { alignItems: 'center', gap: 10, paddingTop: 2 },
  sourcePreview: { width: 190, height: 190, borderRadius: 14 },
  sourceIcon: { alignItems: 'center', justifyContent: 'center' },
  sourceName: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  stepBlock: { gap: 12, paddingTop: 6 },
  // Klaar-melding: vinkje boven de kop, gecentreerd, met lucht eromheen.
  // Er staat maar één knop onder — dan mag dit even staan.
  doneHead: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  // Kop van scherm 2. Zelfde bouw als de event-detail hero: beeld tot
  // aan alle drie de randen, gradient eroverheen, tekst onderin. Dus
  // géén radius en geen marges — de negatieve marges duwen 'm door de
  // body-padding (22) en de paddingTop (8) heen, tot tegen de rand van
  // het sheet. De tekst staat op 22 en lijnt daarmee uit met de knoppen
  // eronder.
  chosenHero: {
    aspectRatio: 3 / 2,
    marginHorizontal: -22,
    marginTop: -8,
    overflow: 'hidden',
    paddingHorizontal: 22,
    paddingBottom: 20,
    justifyContent: 'flex-end',
  },
  chosenHeroBottom: { gap: 4 },
  // Zelfde blok zonder beeld: voor een aanmelding hebben we geen foto,
  // alleen wat jij hebt ingevuld.
  chosenBlock: { gap: 6, alignItems: 'center', paddingHorizontal: 10 },
  chosenMeta: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  chosenNote: {
    fontFamily: fontFamily.medium,
    fontSize: 13,
    lineHeight: 18,
  },
  checking: { alignItems: 'center', gap: 14, paddingVertical: 48 },
  centered: { textAlign: 'center' },
  // Display-maat tussen de event-detail hero (38) en de featured-kaart
  // (34) en die van dit sheet: groot genoeg om kop te zijn, klein genoeg
  // om naast twee knoppen te passen.
  chosenTitle: {
    fontFamily: fontFamily.display,
    fontSize: 28,
    lineHeight: 28 * 0.92,
    letterSpacing: -1.1,
  },
  stepQuestion: {
    fontFamily: fontFamily.display,
    fontSize: 21,
    letterSpacing: -0.45,
    lineHeight: 25,
  },
  stepLead: { fontFamily: fontFamily.body, fontSize: 14, lineHeight: 19 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  // Zelfde vorm als de thumb in `EventListRow`, een maat kleiner: deze
  // rij heeft twee regels tekst, geen vier.
  optionThumb: { width: 56, height: 56, borderRadius: 10 },
  optionThumbFill: { alignItems: 'center', justifyContent: 'center' },
  optionLetter: {
    fontFamily: fontFamily.display,
    fontSize: 24,
    color: 'rgba(0,0,0,0.55)',
  },
  // Een veld, geen keuze — dus de vorm van de zoekpil elders in de app
  // (rond, 44 hoog) in plaats van die van de keuzerijen eromheen. Iets
  // ruimer dan die pil, want hij staat hier tussen rijen van 80.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
    height: 52,
    borderRadius: 999,
  },
  searchInput: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: 15,
    padding: 0,
  },
  // Zelfde maat als `EventListRow` elders in de app: titel bold 15, en de
  // regel eronder bold 12 in gedempte kleur — géén mini-mono. De app
  // gebruikt mono alleen voor korte uppercase-labels, niet voor zinnen.
  optionTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    letterSpacing: -0.22,
    lineHeight: 18,
  },
  optionMeta: {
    fontFamily: fontFamily.bold,
    fontSize: 12,
    letterSpacing: -0.1,
    lineHeight: 16,
  },
  // Knoppen zijn pillen, net als overal in de app (sheetDoneBtn,
  // sheetCloseBtn, de chips). Kaarten en velden houden hun 14, de kop
  // z'n 18 — zelfde maten als de featured-kaart op Vandaag.
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 999,
  },
  primaryBtnText: { fontFamily: fontFamily.bold, fontSize: 15.5 },
  choiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 22,
    // Geen vaste hoogte meer: met de regel over je ticket eronder groeit
    // de knop mee. Beide standen hebben die regel, dus hij springt niet.
    minHeight: 54,
    paddingVertical: 9,
    borderRadius: 999,
  },
  choiceBtnLabel: { gap: 1 },
  choiceBtnText: { fontFamily: fontFamily.medium, fontSize: 15.5 },
  choiceBtnSub: {
    fontFamily: fontFamily.medium,
    fontSize: 12.5,
    lineHeight: 16,
  },
  quietLink: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    paddingVertical: 2,
  },
  ticketCard: {
    gap: 8,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  ticketCardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ticketCardTitle: {
    fontFamily: fontFamily.bold,
    fontSize: 16,
    letterSpacing: -0.2,
  },
  ticketCardBody: {
    fontFamily: fontFamily.body,
    fontSize: 13.5,
    lineHeight: 18,
  },
  fieldRow: { flexDirection: 'row', gap: 12 },
  fieldLabel: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  // 56 hoog en 17px tekst: de maat die iOS zelf voor invoer gebruikt.
  fieldInput: {
    fontFamily: fontFamily.medium,
    fontSize: 17,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  // De titel is de kop van het event en mag dat ook zijn in het formulier.
  fieldInputBig: {
    fontFamily: fontFamily.bold,
    fontSize: 21,
    letterSpacing: -0.3,
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  // iOS: de systeempicker heeft z'n eigen chip-achtergrond, dus geen
  // gevulde box eromheen — anders krijg je een doos in een doos.
  pickerBoxIos: {
    minHeight: 56,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  pickerBox: {
    minHeight: 56,
    borderRadius: 14,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  pickerValue: { fontFamily: fontFamily.medium, fontSize: 16 },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hint: { fontFamily: fontFamily.medium, fontSize: 14 },
  mono: { fontFamily: fontFamily.mono, fontSize: 13, lineHeight: 19 },
  waiting: { alignItems: 'center', gap: 14, paddingTop: 80 },
  waitingText: { fontFamily: fontFamily.body, fontSize: 14 },
  dock: {
    paddingHorizontal: 22,
    paddingTop: 12,
    borderTopWidth: 1,
    gap: 10,
  },
  privacy: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  dockRow: { flexDirection: 'row', gap: 8 },
  closeNarrow: { flex: 0, paddingHorizontal: 26 },
  closeWide: { flex: 1 },
  close: {
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { fontFamily: fontFamily.medium, fontSize: 15 },
});
