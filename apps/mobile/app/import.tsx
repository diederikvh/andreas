import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
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
import { useLocale, useT } from '@/lib/i18n';
import { detectBarcodeTypes } from '@/lib/importBarcode';
import {
  logicalDay,
  matchEvent,
  type MatchCandidate,
  type MatchResult,
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
import { search, submitUnknownEvent } from '@/lib/api';
import * as Haptics from 'expo-haptics';
import { useMode, useRoles } from '@/store/mode';
import { useTicketFor, useTickets, type StoredTicket } from '@/store/tickets';
import { fontFamily, palette } from '@/theme/tokens';

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

  // Op stap 2 met een gekozen event is de foto de kop: geen bovenmarge.
  const overHero = step === 'act' && !selfAdd;

  return (
    <View
      onLayout={onRootLayout}
      style={[styles.root, { backgroundColor: roles.bg }]}
    >
      {/* Alles onder de kop schuift mee omhoog als het keyboard komt —
          bij "zelf toevoegen" typ je in het onderste veld en anders
          staat dat achter het keyboard, samen met de knop eronder. Kan
          hier met een gewone KAV omdat de dock een flex-sibling is en
          geen absolute child (dáár werkt 'ie niet, zie CLAUDE.md). De
          buitenste View blijft ongemeten zo hoog als het scherm, zodat
          de sheet-detectie hierboven niet meegaat schuiven. */}
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
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
            paddingBottom: insets.bottom + 40,
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
              // Op Android is de systeembalk een rij echte knoppen; dan
              // wil je ruimte tússen onze knop en die van het toestel,
              // niet alleen de inset. Op iOS is het een streepje en zit
              // die lucht al in de inset.
              paddingBottom:
                Platform.OS === 'android'
                  ? insets.bottom + 14
                  : Math.max(insets.bottom, 12),
              backgroundColor: roles.bg,
              borderTopColor: roles.bgChip,
            },
          ]}
        >
          {/* Eén knop, twee betekenissen: halverwege stap 2 brengt hij je
            terug naar de keuze, en op stap 1 sluit hij het scherm. Zo hoef
            je niet naar de linkerbovenhoek voor iets wat je met je duim
            doet. Ben je klaar, dan is er niets om naar terug te gaan — een
            save draai je hier niet ongedaan — dus dan sluit hij weer. */}
          <Pressable
            onPress={step === 'act' && !acted ? backToStep1 : onClose}
            style={[
              styles.close,
              { backgroundColor: isNacht ? palette.noir2 : palette.paper2 },
            ]}
          >
            <Text style={[styles.closeText, { color: roles.fg }]}>
              {step === 'act' && !acted
                ? t('Terug', 'Back')
                : t('Sluiten', 'Close')}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

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
  onPickCandidate,
}: {
  share: PendingShare;
  step: 'choose' | 'act';
  pickedId: string | null;
  selfAdd: boolean;
  acted: boolean;
  onActed: () => void;
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

  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [edited, setEdited] = useState(false);

  // Opnieuw extraheren zodra de OCR klaar is of de venuelijst alsnog
  // binnenkomt — maar niet meer nadat de gebruiker zelf iets heeft
  // aangepast. `useVenues` refetcht op focus en geeft dan een nieuwe
  // array-reference; zonder die `edited`-grens zou een refetch je
  // correcties overschrijven.
  useEffect(() => {
    if (edited) return;
    if (scan.status !== 'done' || scan.ocr.blocks.length === 0) return;
    setDraft(extractEventDraft(scan.ocr, { venueNames }));
  }, [scan, venueNames, edited]);

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

  const [chosenIntent, setChosenIntent] = useState<Intent | null>(null);

  const match: MatchResult | null = useMemo(() => {
    if (!matches) return null;
    const candidates: MatchCandidate[] = matches.events.map((e) => ({
      id: e.id,
      title: e.title,
      venueName: e.nextOccurrenceVenue?.name ?? e.venue.name,
      startsAt: e.startsAt,
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

  // Aanmelden stuurt exact wat de whitelist doorlaat — dezelfde `safe` die
  // de matcher gebruikte, geen ruwe OCR. Zie fase 1.7.
  const submitUnknown = async () => {
    if (!isMatchable(safe)) return;
    setSubmitState('sending');
    try {
      await submitUnknownEvent({ ...safe, source: 'share' });
      setSubmitState('done');
    } catch {
      setSubmitState('failed');
    }
  };

  const storedTicket = useTicketFor(occurrenceId);
  // Welke knop bovenaan staat en aan is: de knop die bij de herkenning
  // hoort. Zit er een ticket bij — of hangt er al één aan deze avond —
  // dan ga je. Een poster zonder code is een plan voor later.
  const intent =
    chosenIntent ??
    (storedTicket ? 'going' : suggestedIntent(verdict, share.kind));
  const chosen = match?.ranked.find((r) => r.candidate.id === bestId) ?? null;
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
  const searching = expectsMatch && (matching || matches === undefined);
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
            hasFile={Boolean(share.fileUri)}
            onPick={onPickCandidate}
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
              submitState={submitState}
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
                  storedTicket={storedTicket}
                  onDone={onActed}
                />
              ) : (
                <DoneStep
                  eventId={chosen.candidate.id}
                  hasTicket={Boolean(storedTicket)}
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
  hasFile,
  onPick,
}: {
  busy: boolean;
  match: MatchResult | null;
  draftTitle: string | null;
  hasFile: boolean;
  onPick: (id: string | null) => void;
}) {
  const roles = useRoles();
  const mode = useMode();
  const isNacht = mode === 'nacht';
  const t = useT();

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
          {candidates.length === 0
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
        ) : (
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
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[styles.optionTitle, { color: roles.fg }]}>
              {candidates.length === 0
                ? t('Zelf toevoegen', 'Add it yourself')
                : t('Geen van deze', 'None of these')}
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
      </View>
    </View>
  );
}

/* ── Scherm 2a: zelf toevoegen ───────────────────────────────────────── */

function SelfAddStep({
  draft,
  canSubmit,
  submitState,
  onSubmitUnknown,
  onChangeDraft,
}: {
  draft: EventDraft | null;
  canSubmit: boolean;
  submitState: 'idle' | 'sending' | 'done' | 'failed';
  onSubmitUnknown: () => void;
  onChangeDraft: (patch: Partial<EventDraft>) => void;
}) {
  const roles = useRoles();
  const t = useT();

  if (submitState === 'done') {
    return (
      <View style={styles.stepBlock}>
        <Text style={[styles.stepQuestion, { color: roles.fg }]}>
          {t('Aangemeld — dank je', 'Submitted — thank you')}
        </Text>
        <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
          {t(
            'We kijken ernaar en zetten het in Andreas.',
            'We will look at it and add it to Andreas.',
          )}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.stepBlock}>
      <Text style={[styles.stepQuestion, { color: roles.fg }]}>
        {t('Zelf toevoegen', 'Add it yourself')}
      </Text>
      {draft ? <DraftFields draft={draft} onChange={onChangeDraft} /> : null}
      <Pressable
        onPress={onSubmitUnknown}
        disabled={!canSubmit || submitState === 'sending'}
        style={[
          styles.primaryBtn,
          {
            backgroundColor: roles.accent,
            opacity: !canSubmit || submitState === 'sending' ? 0.45 : 1,
          },
        ]}
      >
        <Ionicons name="add" size={18} color={roles.onAccent} />
        <Text style={[styles.primaryBtnText, { color: roles.onAccent }]}>
          {submitState === 'sending'
            ? t('Aanmelden…', 'Submitting…')
            : t('Aanmelden bij Andreas', 'Submit to Andreas')}
        </Text>
      </Pressable>
      {!canSubmit ? (
        <Text style={[styles.stepLead, { color: roles.fgMuted }]}>
          {t(
            'Vul minstens een titel of een venue in.',
            'Fill in at least a title or a venue.',
          )}
        </Text>
      ) : null}
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
  storedTicket,
  onDone,
}: {
  candidate: MatchCandidate;
  share: PendingShare;
  verdict: TicketVerdict;
  intent: Intent;
  onChoose: (intent: Intent) => void;
  occurrenceId: string | null;
  storedTicket: StoredTicket | undefined;
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
                {t('Je ticket staat hierbij', 'Your ticket is saved here')}
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
        // De hele kaart schakelt, niet alleen het schuifje: een doelwit van
        // 40×24 is te klein voor een keuze die bepaalt of je aan de deur
        // iets te tonen hebt.
        <Pressable
          onPress={() => setKeepAsTicket(!willKeep)}
          style={[
            styles.ticketCard,
            {
              backgroundColor: cardBg,
              borderColor: willKeep ? roles.accent : 'transparent',
            },
          ]}
        >
          <View style={styles.ticketCardHead}>
            <Ionicons
              name="ticket"
              size={19}
              color={willKeep ? roles.accent : roles.fgMuted}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[styles.ticketCardTitle, { color: roles.fg }]}>
                {storedTicket
                  ? t('Deze er ook bij?', 'Keep this one too?')
                  : verdict.isTicket
                    ? fileCount > 1
                      ? t(
                          'Dit lijken je tickets',
                          'These look like your tickets',
                        )
                      : t('Dit lijkt je ticket', 'This looks like your ticket')
                    : fileCount > 1
                      ? t('Bewaren als tickets?', 'Keep as your tickets?')
                      : t('Bewaren als ticket?', 'Keep as your ticket?')}
              </Text>
              <Text style={[styles.ticketCardBody, { color: roles.fgMuted }]}>
                {willKeep
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
                      )}
              </Text>
            </View>
            {/* Niet zelf aantikbaar — de kaart eromheen vangt de tik, zodat
                één gebaar niet twee keer kan omschakelen. Verticaal
                gecentreerd tegen het hele tekstblok, niet tegen de kop. */}
            <View pointerEvents="none">
              <Switch
                value={willKeep}
                trackColor={{ true: roles.accent, false: roles.bgChip }}
                thumbColor={isNacht ? palette.ink : palette.paper3}
              />
            </View>
          </View>
        </Pressable>
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

/* ── Stap 3: klaar ───────────────────────────────────────────────────── */

function DoneStep({
  eventId,
  hasTicket,
}: {
  eventId: string;
  hasTicket: boolean;
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
          {hasTicket
            ? t('Ticket staat erbij', 'Ticket is saved')
            : t('Staat in je plannen', 'Added to your plans')}
        </Text>
      </View>

      <Pressable
        onPress={() => router.push(`/event/${eventId}?source=share` as never)}
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
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
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
  close: {
    height: 48,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { fontFamily: fontFamily.medium, fontSize: 15 },
});
