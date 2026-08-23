/**
 * Client-state voor de conversationele zoek ("Andreas-gids").
 *
 * Stateless aan de serverkant (brief §5): deze store houdt het
 * `PreferenceProfile` + de berichtgeschiedenis vast en stuurt die elke beurt
 * mee. De server geeft het bijgewerkte profiel terug, dat we hier bewaren.
 *
 * In-memory (geen persist): een gesprek leeft per sessie. Reopenen van het
 * scherm behoudt de lopende conversatie; een app-herstart begint vers.
 */
import { create } from 'zustand';

import {
  EMPTY_PROFILE,
  postZoek,
  type ApiEvent,
  type PreferenceProfile,
  type ZoekChatTurn,
} from '@/lib/api';

let nextId = 0;
const makeId = () => `m${nextId++}`;

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string;
      role: 'assistant';
      text: string;
      events: ApiEvent[];
      reasonByEventId: Record<string, string>;
      needsMoreInfo?: string;
    };

type ZoekState = {
  messages: ChatMessage[];
  profile: PreferenceProfile;
  sending: boolean;
  error: string | null;
  /** Zichtbaarheid van de gids-overlay. Globaal (niet per scherm) zodat de
      overlay op tabs-layout-niveau boven de TabBar gerenderd kan worden. */
  guideOpen: boolean;
  openGuide: () => void;
  closeGuide: () => void;
  /** Idem voor de zoek-overlay. Zat eerder als lokale state in avond.tsx,
      maar de zoek-knop staat nu in de AppHeader en moet dus vanaf elk
      scherm te openen zijn. */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** Verstuur een gebruikersbericht en verwerk de beurt. */
  send: (text: string) => Promise<void>;
  /** Begin een vers gesprek. */
  reset: () => void;
};

export const useZoekStore = create<ZoekState>((set, get) => ({
  messages: [],
  profile: { ...EMPTY_PROFILE },
  sending: false,
  error: null,
  guideOpen: false,
  openGuide: () => set({ guideOpen: true }),
  closeGuide: () => set({ guideOpen: false }),
  searchOpen: false,
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),

  send: async (raw: string) => {
    const text = raw.trim();
    if (!text || get().sending) return;

    // History = de tekst-beurten van vóór dit bericht (server krijgt het
    // nieuwe bericht apart als `message`).
    const history: ZoekChatTurn[] = get().messages.map((m) => ({
      role: m.role,
      content: m.text,
    }));

    const userMsg: ChatMessage = { id: makeId(), role: 'user', text };
    set((s) => ({
      messages: [...s.messages, userMsg],
      sending: true,
      error: null,
    }));

    try {
      const res = await postZoek({ message: text, profile: get().profile, history });
      const assistant: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        text: res.reply,
        events: res.events ?? [],
        reasonByEventId: res.reasonByEventId ?? {},
        needsMoreInfo: res.needsMoreInfo,
      };
      set((s) => ({
        messages: [...s.messages, assistant],
        profile: res.updatedProfile ?? s.profile,
        sending: false,
      }));
    } catch (e) {
      set({
        sending: false,
        error:
          e instanceof Error
            ? e.message
            : 'Er ging iets mis. Probeer het nog eens.',
      });
    }
  },

  reset: () =>
    set({
      messages: [],
      profile: { ...EMPTY_PROFILE },
      sending: false,
      error: null,
    }),
}));
