import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { ShareIntent } from 'expo-share-intent';

import { isTicketFile } from '@/store/tickets';

/**
 * Content die van buiten Andreas naar binnen komt (share-sheet, later de
 * poster-scanner). Fase 1 van "Share naar Andreas" — zie
 * [docs/share-naar-andreas.md](../../../docs/share-naar-andreas.md).
 *
 * Twee harde regels die de vorm van dit bestand bepalen:
 *
 *  1. **Niets gaat naar de server.** Deze module praat niet met `lib/api.ts`.
 *     De enige route naar buiten loopt via `lib/importPayload.ts`, dat
 *     uitsluitend gestructureerde event-metadata doorlaat.
 *  2. **Bestanden zijn lokaal en blijven lokaal.** iOS ruimt de
 *     share-extension-container op, dus we kopiëren meteen naar de
 *     document-dir. De store bewaart alleen ons eigen pad.
 *
 * Zelfde opzet als [pendingShareInvite.ts](./pendingShareInvite.ts): de
 * payload overleeft een cold start, zodat de root-layout hem kan oppakken
 * zodra de app klaar is met hydrateren.
 */

export type PendingShareKind = 'url' | 'text' | 'image' | 'pdf' | 'file';

export type PendingShare = {
  kind: PendingShareKind;
  /** Ruwe tekst bij `text`, of de tekst waar de URL uit kwam. */
  text?: string | null;
  /** Bij `url` — de link zoals de share-sheet hem gaf. */
  url?: string | null;
  /** Titel/og-title die de bron-app meestuurde. Niet altijd aanwezig. */
  title?: string | null;
  /** Ons eigen pad in de document-dir, niet het pad van de bron-app. */
  fileUri?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  receivedAt: number;
};

/** Waar geïmporteerde bestanden landen. Buiten de cache-dir, want die
    mag het systeem weggooien — een ticket wil je niet kwijt zijn. */
const IMPORT_DIR = 'import';

/**
 * Gooi alles in de import-map weg behalve het bestand dat bij de huidige
 * pending share hoort.
 *
 * Nodig omdat opruimen-bij-sluiten alleen werkt als de gebruiker de flow
 * ook afmaakt. Wordt de app tussendoor gekilld — of deel je iets en zwaai
 * je 'm direct weg — dan blijft het bestand staan zonder dat er nog UI
 * naartoe leidt. Dat stapelt op, en bij een ticket-PDF is dat precies het
 * soort bestand dat je niet ongemerkt wil laten liggen.
 *
 * Draait één keer per launch vanuit `<ShareImportCapture />`, zodra
 * duidelijk is of er een nieuwe share binnenkomt — anders zou hij het
 * bestand kunnen wissen dat net gekopieerd is.
 *
 * Bestanden die aan een bewaard ticket hangen blijven staan: die zijn
 * geen restafval maar precies het tegenovergestelde.
 */
export function pruneImportDir(keepUri: string | null): void {
  try {
    const dir = new Directory(Paths.document, IMPORT_DIR);
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (entry instanceof Directory) continue;
      if (keepUri && entry.uri === keepUri) continue;
      if (isTicketFile(entry.uri)) continue;
      try {
        entry.delete();
      } catch {
        /* volgende launch dan */
      }
    }
  } catch {
    /* map niet leesbaar — geen reden om de import te laten stranden */
  }
}

function importDirectory(): Directory {
  const dir = new Directory(Paths.document, IMPORT_DIR);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Vervang alles wat geen letter/cijfer/punt/streepje is. Bestandsnamen
    uit andere apps bevatten spaties, emoji en soms slashes. */
function safeFileName(name: string | undefined, fallbackExt: string): string {
  const cleaned = (name ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  if (cleaned.length > 0 && cleaned.includes('.')) return cleaned.slice(-120);
  const base = cleaned.length > 0 ? cleaned.slice(-100) : 'shared';
  return `${base}.${fallbackExt}`;
}

function extFromMime(mimeType: string | undefined): string {
  if (!mimeType) return 'bin';
  if (mimeType === 'application/pdf') return 'pdf';
  const sub = mimeType.split('/')[1] ?? 'bin';
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/gi, '') || 'bin';
}

function kindForMime(mimeType: string | undefined): PendingShareKind {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'file';
}

/**
 * Kopieer een gedeeld bestand naar onze eigen document-dir en geef het
 * nieuwe pad terug. Faalt-stil met `null`: een mislukte kopie mag de
 * importflow niet laten crashen, het scherm toont dan gewoon geen preview.
 */
function copyIntoImportDir(
  sourceUri: string,
  fileName: string | undefined,
  mimeType: string | undefined
): { uri: string; size: number | null } | null {
  try {
    const source = new File(sourceUri);
    if (!source.exists) return null;
    const target = new File(
      importDirectory(),
      `${Date.now()}-${safeFileName(fileName, extFromMime(mimeType))}`
    );
    source.copy(target);
    return { uri: target.uri, size: target.size ?? null };
  } catch {
    return null;
  }
}

/**
 * `ShareIntent` → onze eigen vorm, met het bestand al gekopieerd.
 *
 * expo-share-intent geeft `type: 'weburl' | 'text' | 'media' | 'file'`; wij
 * splitsen media/file verder op mimetype, want een PDF-ticket en een
 * poster-screenshot gaan straks door een andere pipeline.
 *
 * Meerdere bestanden in één share: we nemen de eerste. Eén poster of één
 * ticket is het geval waar dit voor bestaat; multi-select kan later.
 */
export function normalizeShareIntent(intent: ShareIntent): PendingShare | null {
  const receivedAt = Date.now();
  const title = intent.meta?.title ?? null;

  const file = intent.files?.[0];
  if (file) {
    const copied = copyIntoImportDir(file.path, file.fileName, file.mimeType);
    return {
      kind: kindForMime(file.mimeType),
      title,
      fileUri: copied?.uri ?? null,
      fileName: file.fileName ?? null,
      mimeType: file.mimeType ?? null,
      size: copied?.size ?? file.size ?? null,
      width: file.width ?? null,
      height: file.height ?? null,
      receivedAt,
    };
  }

  if (intent.webUrl) {
    return {
      kind: 'url',
      url: intent.webUrl,
      text: intent.text ?? null,
      title,
      receivedAt,
    };
  }

  if (intent.text) {
    return { kind: 'text', text: intent.text, title, receivedAt };
  }

  return null;
}

type State = {
  pending: PendingShare | null;
  hydrated: boolean;
  setPending: (share: PendingShare) => void;
  /** Wis de payload. Een bestand dat aan een bewaard ticket hangt blijft
      altijd staan; `keepFile` is er voor de overige gevallen. */
  clearPending: (opts?: { keepFile?: boolean }) => void;
};

export const usePendingShare = create<State>()(
  persist(
    (set, get) => ({
      pending: null,
      hydrated: false,
      setPending: (share) => set({ pending: share }),
      clearPending: ({ keepFile = false } = {}) => {
        const uri = get().pending?.fileUri;
        // Het ticket van de gebruiker wissen omdat hij een scherm sluit is
        // precies het verkeerde. De store is de eigenaar zodra hij hangt.
        if (uri && !keepFile && !isTicketFile(uri)) {
          try {
            const f = new File(uri);
            if (f.exists) f.delete();
          } catch {
            /* verweesd bestand is hinderlijk, geen reden om te crashen */
          }
        }
        set({ pending: null });
      },
    }),
    {
      name: 'andreas:pending-share.v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ pending: s.pending }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    }
  )
);
