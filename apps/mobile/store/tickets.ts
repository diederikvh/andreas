import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMemo } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Tickets die de gebruiker aan Andreas heeft gegeven, gekoppeld aan de
 * occurrence waar ✓ Ik ga op staat.
 *
 * **Alles blijft lokaal.** Deze store praat niet met de API en het
 * ticketbestand gaat nergens naartoe: het staat in `Documents/import/` en
 * we bewaren hier alleen het pad. Dat is de harde regel uit de
 * featurelijn, en de reden dat de viewer het originele bestand toont in
 * plaats van een QR die wij zouden reconstrueren — we lézen de inhoud van
 * die code niet eens (zie `lib/importBarcode.ts`).
 *
 * Let op de wisselwerking met het opruimen: `clearPending()` en
 * `pruneImportDir()` in [pendingShare.ts](../lib/pendingShare.ts) gooien
 * alles weg wat niet bij de huidige share hoort. Zodra een bestand hier
 * staat mag dat juist niet meer — vandaar {@link isTicketFile}, dat die
 * twee als uitzondering gebruiken.
 */

export type StoredTicket = {
  occurrenceId: string;
  eventId: string;
  eventTitle: string | null;
  /** Ons eigen pad in de document-dir. */
  fileUri: string;
  fileName: string | null;
  mimeType: string | null;
  /** Wanneer die avond is (ISO). Nodig om afgelopen kaartjes te kunnen
      tonen en opruimen: zonder dit weet een ticket alleen dat het bestaat.
      Leeg bij kaartjes van vóór 13 sep 2026. */
  startsAt?: string | null;
  /** Welke codetypes er lokaal gevonden zijn — niet de inhoud ervan.
      De viewer gebruikt het alleen om te zeggen "scan de code op je
      ticket" in plaats van te doen alsof hij hem kent. */
  barcodeTypes: string[];
  addedAt: number;
};

type State = {
  /** Gesleuteld op occurrenceId. Meerdere per avond mag: twee mensen,
      twee bestanden — of een vervanger die de venue opstuurde. */
  tickets: Record<string, StoredTicket[]>;
  hydrated: boolean;
  attach: (ticket: StoredTicket) => void;
  /** Ontkoppelen én het bestand weggooien — de gebruiker wil het weg.
      Zonder `fileUri` gaan ze allemaal weg. */
  detach: (occurrenceId: string, fileUri?: string) => void;
  /** Verhuis alles wat onder `from` hangt naar `to`. */
  move: (from: string, to: string) => void;
};

function deleteFile(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* verweesd bestand is hinderlijk, geen reden om te crashen */
  }
}

export const useTickets = create<State>()(
  persist(
    (set, get) => ({
      tickets: {},
      hydrated: false,
      attach: (ticket) =>
        set((s) => {
          const current = s.tickets[ticket.occurrenceId] ?? [];
          // Twee keer hetzelfde bestand delen mag geen dubbele opleveren.
          if (current.some((t) => t.fileUri === ticket.fileUri)) return s;
          return {
            tickets: {
              ...s.tickets,
              [ticket.occurrenceId]: [...current, ticket],
            },
          };
        }),
      /**
       * Je aanmelding is een echt event geworden.
       *
       * Het bestand blijft staan waar het staat; alleen de sleutel
       * verandert, van `sub-…` naar de occurrence. Zonder dit blijft je
       * ticket hangen aan een kaart die uit beeld verdwijnt zodra de
       * echte avond in je plannen verschijnt.
       */
      move: (from, to) =>
        set((s) => {
          const moving = s.tickets[from];
          if (!moving || moving.length === 0 || from === to) return s;
          const next = { ...s.tickets };
          delete next[from];
          const already = next[to] ?? [];
          const names = new Set(already.map((t) => t.fileUri.split('/').pop()));
          next[to] = [
            ...already,
            ...moving
              .filter((t) => !names.has(t.fileUri.split('/').pop()))
              .map((t) => ({ ...t, occurrenceId: to })),
          ];
          return { tickets: next };
        }),
      detach: (occurrenceId, fileUri) => {
        const current = get().tickets[occurrenceId] ?? [];
        for (const t of current) {
          if (!fileUri || t.fileUri === fileUri) deleteFile(ticketFileUri(t.fileUri));
        }
        const keep = fileUri
          ? current.filter((t) => t.fileUri !== fileUri)
          : [];
        set((s) => {
          const next = { ...s.tickets };
          if (keep.length > 0) next[occurrenceId] = keep;
          else delete next[occurrenceId];
          return { tickets: next };
        });
      },
    }),
    {
      name: 'andreas:tickets.v1',
      version: 2,
      // v1 had één ticket per occurrence. Zelfde sleutel houden en de
      // opgeslagen waarde in een lijst wikkelen, anders raakt iemand met
      // een bewaard ticket het kwijt bij de volgende start.
      migrate: (persisted, version) => {
        const state = persisted as { tickets?: Record<string, unknown> };
        if (version >= 2 || !state?.tickets) return state;
        const tickets: Record<string, StoredTicket[]> = {};
        for (const [id, value] of Object.entries(state.tickets)) {
          tickets[id] = Array.isArray(value)
            ? (value as StoredTicket[])
            : [value as StoredTicket];
        }
        return { ...state, tickets };
      },
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ tickets: s.tickets }),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);

/** Het eerste ticket voor deze occurrence, of niets. Genoeg voor de
    plekken die alleen willen weten óf er een ticket hangt. */
export function useTicketFor(occurrenceId: string | null | undefined) {
  return useTickets((s) =>
    occurrenceId ? s.tickets[occurrenceId]?.[0] : undefined,
  );
}

/**
 * Alles wat je bewaard hebt, nieuwste eerst.
 *
 * De enige plek waar je je kaartjes als lijst ziet. Dat was met opzet
 * lang niet zo — ze horen bij een avond — maar na die avond verdwijnt de
 * avond uit je plannen en was het bestand onbereikbaar: je kon het niet
 * meer tonen én niet meer weggooien.
 */
export function useAllTickets(): StoredTicket[] {
  const tickets = useTickets((s) => s.tickets);
  return useMemo(
    () =>
      Object.values(tickets)
        .flat()
        .sort((a, b) => b.addedAt - a.addedAt),
    [tickets]
  );
}

/** Alle tickets voor deze occurrence. */
export function useTicketsFor(occurrenceId: string | null | undefined) {
  return useTickets((s) =>
    occurrenceId ? (s.tickets[occurrenceId] ?? EMPTY) : EMPTY,
  );
}

/** Stabiele lege lijst: anders geeft de selector elke render een nieuwe
    array en rendert alles wat 'm gebruikt oneindig door. */
const EMPTY: StoredTicket[] = [];

function fileName(uri: string | null | undefined): string | null {
  return uri?.split('/').pop() || null;
}

/**
 * Waar dit ticket **nu** staat.
 *
 * Het pad dat we bewaarden bevat op iOS de UUID van de app-container, en
 * die verandert bij elke installatie — bij elke update uit de store dus.
 * Het bestand verhuist mee, het opgeslagen pad niet, en dan wijst een
 * bewaard ticket naar een map die niet meer bestaat: de viewer toont niets
 * en het opruimen ziet er geen ticket meer in. Dus zoeken we het bij het
 * lezen opnieuw op, onder z'n eigen naam.
 *
 * De mapnaam staat ook in `lib/pendingShare.ts`; die hier niet importeren,
 * want dat bestand leest {@link isTicketFile} en dan krijg je een kringetje.
 */
export function ticketFileUri(uri: string): string {
  const name = fileName(uri);
  return name ? new File(new Directory(Paths.document, 'import'), name).uri : uri;
}

/**
 * Hoort dit bestand bij een bewaard ticket? Gebruikt door het opruimen in
 * `pendingShare.ts`, dat anders het ticket zou wissen dat de gebruiker net
 * heeft toegevoegd.
 *
 * Buiten React leesbaar (via `getState`) omdat de opruimers geen hooks zijn.
 */
export function isTicketFile(uri: string | null | undefined): boolean {
  const name = fileName(uri);
  if (!name) return false;
  return Object.values(useTickets.getState().tickets).some((list) =>
    list.some((t) => fileName(t.fileUri) === name),
  );
}
