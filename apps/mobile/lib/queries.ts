import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import {
  acceptFriendRequest,
  addGroupMembers,
  createGroup,
  declineFriendRequest,
  getAgendaDay,
  getAgendaDays,
  getArtist,
  getEvent,
  getEventGenres,
  getEvents,
  bulkFollowVenues,
  getBootstrapSuggestions,
  getForYouEvents,
  getForYouFeed,
  getNewEventsSince,
  type Lane,
  getRecentEvents,
  getFriendDetail,
  getFriendRequests,
  getFriends,
  getGroup,
  getGroups,
  getInvitations,
  getMe,
  getOutgoingFriendRequests,
  getMySaves,
  getSeries,
  getSeriesList,
  getSocialFeed,
  getVenue,
  getVenueSubtypes,
  getVenues,
  muteGroup,
  remindInvitation,
  removeFriend,
  removeGroupMember,
  renameGroup,
  deleteGroup,
  respondInvitation,
  revokeInvitation,
  setFriendFavorite,
  type ApiFriendDetail,
  searchUsers,
  sendFriendRequest,
  sendInvitations,
  setVenueFollow,
  toggleDismiss,
  toggleSave,
  unmuteGroup,
  getMirrorByHandle,
  getMyDismisses,
  getMyMirror,
  type AgendaFilters,
  type ApiMe,
  type EventsFilter,
  type Mirror,
  type PublicMirror,
  type SaveSource,
  type SavedApiEvent,
  type VenueCategory,
  type VenueFollowState,
  type VenueType,
} from '@/lib/api';
import { useSession } from '@/lib/authClient';

export const queryKeys = {
  events: (filter: EventsFilter = {}) => ['events', filter] as const,
  event: (id: string) => ['event', id] as const,
  eventGenres: () => ['event-genres'] as const,
  // `from`/`to` bewust NIET in de key — die schuiven elke tab-focus
  // op (focusedNow tikt) en zouden anders steeds een nieuwe queryKey
  // produceren waardoor je terugkomend van een detail-pagina opnieuw
  // moet wachten op de spinner. De queryFn-closure pakt nog steeds de
  // verse `from` bij elke refetch; staleTime (10 min) bepaalt of er
  // achter de schermen een refetch fired.
  agendaDays: (input: { filters: AgendaFilters }) =>
    ['agenda-days', input.filters] as const,
  agendaDay: (input: { date: string; filters: AgendaFilters }) =>
    ['agenda-day', input.date, input.filters] as const,
  mirror: () => ['mirror', 'me'] as const,
  forYou: (opts: { weekOnly?: boolean; tonight?: boolean } = {}) =>
    [
      'events',
      'for-you',
      opts.tonight ? 'tonight' : opts.weekOnly ? 'week' : 'rail',
    ] as const,
  forYouFeed: (categories?: string[]) =>
    [
      'events',
      'for-you',
      'feed',
      categories && categories.length > 0
        ? [...categories].sort().join(',')
        : 'all',
    ] as const,
  newArrivalsSince: (
    sinceIso: string | null,
    lanes: string,
    limit: number
  ) => ['events', 'new', 'since', sinceIso ?? 'pending', lanes, limit] as const,
  recentEvents: (limit: number) =>
    ['events', 'new', 'recent', limit] as const,
  dismisses: () => ['dismisses'] as const,
  artist: (slug: string) => ['artist', slug] as const,
  venue: (slug: string) => ['venue', slug] as const,
  venues: (input: { q?: string; category?: string } = {}) =>
    ['venues', input.q ?? '', input.category ?? ''] as const,
  series: (slug: string) => ['series', slug] as const,
  seriesList: (input: { q?: string; category?: string } = {}) =>
    ['series-list', input.q ?? '', input.category ?? ''] as const,
  saves: () => ['saves'] as const,
  friends: () => ['friends'] as const,
  friendRequests: () => ['friend-requests'] as const,
  outgoingFriendRequests: () => ['outgoing-friend-requests'] as const,
  friend: (id: string) => ['friend', id] as const,
  userSearch: (q: string) => ['user-search', q] as const,
  invitations: () => ['invitations'] as const,
  groups: () => ['groups'] as const,
  group: (id: string) => ['group', id] as const,
  socialFeed: () => ['social-feed'] as const,
  me: (userId: string | null) => ['me', userId] as const,
};

// `useMe()` — gedeelde profiel-query. Sleutel matcht met wat /jij
// gebruikt zodat de cache hergebruikt wordt en avatar/naam in de
// header direct beschikbaar zijn nadat /jij ze heeft opgehaald.
export function useMe() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  return useQuery<ApiMe | null>({
    queryKey: queryKeys.me(userId),
    queryFn: () => getMe(),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
  });
}

export function useEvents(filter: EventsFilter = {}) {
  return useQuery({
    queryKey: queryKeys.events(filter),
    queryFn: () => getEvents(filter),
    // Stale na 10 min: tab-focus binnen die tijd gebruikt cache (geen
    // refetch bij heen-en-weer-tikken Avond/Agenda), maar zodra je
    // langer wegbent of de app uit background komt en de data is
    // ouder dan 10 min, ververst-ie automatisch. Plus: client-side
    // filtert `useNowMinute()` continu op effectieve eindtijd, dus
    // de bovenste rij wordt nooit een dood event.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Wat is er sinds `since` aan het systeem toegevoegd — nieuwe events én
 * nieuwe datums bij bestaande events. Voor de badge op Avond en de
 * lijst op /new. `since` mag null zijn (eerste sessie ooit) — query
 * staat dan op pauze.
 *
 * Levert `{ events, total, laneCounts }`: de server capt de lijst zodat
 * de pagina af te maken blijft, `total` zegt hoeveel er achter die cap
 * zit.
 */
export function useNewArrivalsSince(
  since: Date | null,
  opts: { enabled?: boolean; lanes?: Lane[]; limit?: number } = {}
) {
  const sinceIso = since ? since.toISOString() : null;
  const lanes = opts.lanes ?? [];
  const laneKey = lanes.length > 0 ? [...lanes].sort().join(',') : 'all';
  const limit = opts.limit ?? 0;
  return useQuery({
    queryKey: queryKeys.newArrivalsSince(sinceIso, laneKey, limit),
    queryFn: () => getNewEventsSince(since!, { lanes, limit: opts.limit }),
    enabled: (opts.enabled ?? true) && Boolean(since),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Fallback-query voor /new: laatste N recente events sowieso.
 * Mounten met enabled=true alleen wanneer de since-query leeg is —
 * anders verspil je een round-trip.
 */
export function useRecentEvents(
  limit = 10,
  opts: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.recentEvents(limit),
    queryFn: () => getRecentEvents(limit),
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useForYouEvents(
  opts: { enabled?: boolean; weekOnly?: boolean; tonight?: boolean } = {},
) {
  return useQuery({
    queryKey: queryKeys.forYou({ weekOnly: opts.weekOnly, tonight: opts.tonight }),
    queryFn: () =>
      getForYouEvents({ weekOnly: opts.weekOnly, tonight: opts.tonight }),
    enabled: opts.enabled ?? true,
    // Score-based aanbevelingen veranderen niet razendsnel; matchen
    // intern op saves+follows. Refresh op tab-focus zodat een nieuwe
    // save in de huidige sessie de rail bijwerkt.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Preview voor de Aanbevolen-onboarding picker. Alleen actief als
    beide scenes én flavor zijn gekozen. */
export function useBootstrapSuggestions(input: {
  scenes: import('@/lib/api').AanbevolenScene[];
  flavor: import('@/lib/api').AanbevolenFlavor | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      'bootstrap-suggestions',
      [...input.scenes].sort().join(','),
      input.flavor ?? 'none',
    ] as const,
    queryFn: () =>
      getBootstrapSuggestions({
        scenes: input.scenes,
        flavor: input.flavor!,
      }),
    enabled:
      (input.enabled ?? true) && input.scenes.length > 0 && Boolean(input.flavor),
    staleTime: 60_000,
  });
}

/** Bulk follow. Mutation invalidateert venues + for-you queries zodat
    de feed onmiddellijk vult na onboarding-commit. */
export function useBulkFollowVenues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (venueIds: string[]) => bulkFollowVenues(venueIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', 'for-you'] });
      qc.invalidateQueries({ queryKey: ['venues'] });
    },
  });
}

/** Chronologische "Voor jou"-feed met infinite scroll. Gebruikt op
    `/voor-jou`. Pagina-size 20, cursor van server. Multi-select
    category-filter — leeg = alle categorieën. Wijziging in chip-
    selectie reset de pagination omdat de queryKey wijzigt. */
export function useForYouFeed(
  opts: {
    enabled?: boolean;
    categories?: import('@/lib/api').ApiEvent['category'][];
  } = {},
) {
  return useInfiniteQuery({
    queryKey: queryKeys.forYouFeed(opts.categories),
    queryFn: ({ pageParam }) =>
      getForYouFeed({
        cursor: pageParam as string | null,
        limit: 20,
        categories: opts.categories,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: opts.enabled ?? true,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.event(id),
    queryFn: () => getEvent(id),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useArtist(slug: string) {
  return useQuery({
    queryKey: queryKeys.artist(slug),
    queryFn: () => getArtist(slug),
    enabled: Boolean(slug),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Day-strip data voor de Agenda: één rij per logische dag (06:00-cutoff)
 * met count. Lichte aggregate-query — geen row-data. Filters bepalen
 * welke dagen meedoen, zodat de strip alleen dagen toont met matches.
 */
export function useAgendaDays(input: {
  from: string;
  to: string;
  filters: AgendaFilters;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.agendaDays({ filters: input.filters }),
    queryFn: () =>
      getAgendaDays({
        from: input.from,
        to: input.to,
        filters: input.filters,
      }),
    enabled: input.enabled ?? true,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Lean rows voor één logische agenda-dag. Window-fetch: nieuwe `date`
 * = nieuwe query, dus cache per dag. Voorgaande/volgende dag worden
 * via prefetch warmgehouden zodat tap-navigatie instant aanvoelt.
 */
export function useAgendaDay(input: {
  date: string | null;
  /** Cutoff voor verlopen events op "vandaag" — laat undefined voor
      toekomstige dagen (geen no-op, scheelt 'm uit de query-key). */
  from?: string;
  filters: AgendaFilters;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: queryKeys.agendaDay({
      date: input.date ?? '',
      filters: input.filters,
    }),
    queryFn: () =>
      getAgendaDay({
        date: input.date!,
        from: input.from,
        filters: input.filters,
      }),
    enabled: Boolean(input.date) && (input.enabled ?? true),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useAgendaDayPrefetch() {
  const qc = useQueryClient();
  return (input: {
    date: string;
    from?: string;
    filters: AgendaFilters;
  }) =>
    qc.prefetchQuery({
      queryKey: queryKeys.agendaDay({
        date: input.date,
        filters: input.filters,
      }),
      queryFn: () =>
        getAgendaDay({
          date: input.date,
          from: input.from,
          filters: input.filters,
        }),
      staleTime: 10 * 60_000,
    });
}

export function useEventGenres() {
  return useQuery({
    queryKey: queryKeys.eventGenres(),
    queryFn: () => getEventGenres(),
    staleTime: 5 * 60 * 1000, // 5 min — distinct genres muteren langzaam
  });
}

export function useVenue(slug: string) {
  return useQuery({
    queryKey: queryKeys.venue(slug),
    queryFn: () => getVenue(slug),
    enabled: Boolean(slug),
    // Programma binnen een venue muteert pas zodra een nieuwe ingest-
    // run is gedraaid; 10 min stale dekt het zonder onnodige fetches.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useVenueSubtypes(types?: VenueType[]) {
  return useQuery({
    queryKey: ['venue-subtypes', types ?? []] as const,
    queryFn: () => getVenueSubtypes(types),
    // Subtypes muteren even traag als de venues zelf — 10 min stale.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useVenues(input: {
  q?: string;
  category?: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst' | 'Lezing';
  type?:
    | 'galerie'
    | 'museum'
    | 'podium'
    | 'club'
    | 'film'
    | 'ruimte'
    | 'boekhandel-cafe';
  dayNight?: 'day' | 'night' | 'both';
  scene?: 'mainstream' | 'alternatief' | 'underground' | 'fringe';
} = {}) {
  return useQuery({
    queryKey: [
      'venues',
      input.q ?? '',
      input.category ?? '',
      input.type ?? '',
      input.dayNight ?? '',
      input.scene ?? '',
    ] as const,
    queryFn: () => getVenues(input),
    // Venue-lijst muteert relatief weinig (admin voegt zelden iets toe);
    // 10 min stale + refetch on focus is genoeg.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useSeries(slug: string) {
  return useQuery({
    queryKey: queryKeys.series(slug),
    queryFn: () => getSeries(slug),
    enabled: Boolean(slug),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useSeriesList(
  input: { q?: string; category?: VenueCategory; enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.seriesList({ q: input.q, category: input.category }),
    queryFn: () => getSeriesList(input),
    enabled: input.enabled ?? true,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useMySaves(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.saves(),
    queryFn: () => getMySaves(),
    enabled: opts.enabled ?? true,
  });
}

type ToggleSaveInput = { occurrenceId: string; source?: SaveSource | null };

export function useToggleSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ToggleSaveInput | string) => {
      const occurrenceId =
        typeof input === 'string' ? input : input.occurrenceId;
      const source = typeof input === 'string' ? null : input.source;
      return toggleSave(occurrenceId, source);
    },
    onMutate: async (input) => {
      const occurrenceId =
        typeof input === 'string' ? input : input.occurrenceId;
      await qc.cancelQueries({ queryKey: queryKeys.saves() });
      const prev = qc.getQueryData<SavedApiEvent[]>(queryKeys.saves());
      // Optimistic: verwijder als aanwezig (op occurrence-id), anders
      // niets toevoegen (we hebben hier het volledige event-object niet;
      // volledige refresh komt via onSettled).
      if (prev) {
        qc.setQueryData<SavedApiEvent[]>(
          queryKeys.saves(),
          prev.filter((e) => e.occurrenceId !== occurrenceId)
        );
      }
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.saves(), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.saves() });
      qc.invalidateQueries({ queryKey: queryKeys.mirror() });
      qc.invalidateQueries({ queryKey: queryKeys.forYou() });
      // Prefix-invalidate over álle since/lane/limit-varianten. Zonder
      // dit serveert de bewaarde cache na een koude herstart nog even
      // de lijst van vóór je oordeel, en staat je weggetikte event er
      // gewoon weer — dat leest als "mijn nee is niet aangekomen".
      qc.invalidateQueries({ queryKey: ['events', 'new'] });
    },
  });
}

type ToggleDismissInput = { occurrenceId: string; source?: SaveSource | null };

export function useToggleDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ToggleDismissInput | string) =>
      typeof input === 'string'
        ? toggleDismiss(input)
        : toggleDismiss(input.occurrenceId, input.source),
    onMutate: async (input) => {
      const occurrenceId =
        typeof input === 'string' ? input : input.occurrenceId;
      await qc.cancelQueries({ queryKey: queryKeys.dismisses() });
      const prev = qc.getQueryData<string[]>(queryKeys.dismisses()) ?? [];
      // Optimistic: voeg toe als 'ie nog niet in de lijst staat,
      // verwijder anders (toggle).
      const next = prev.includes(occurrenceId)
        ? prev.filter((id) => id !== occurrenceId)
        : [...prev, occurrenceId];
      qc.setQueryData<string[]>(queryKeys.dismisses(), next);
      return { prev };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.dismisses(), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.dismisses() });
      qc.invalidateQueries({ queryKey: queryKeys.mirror() });
      qc.invalidateQueries({ queryKey: queryKeys.forYou() });
      // Prefix-invalidate over álle since/lane/limit-varianten. Zonder
      // dit serveert de bewaarde cache na een koude herstart nog even
      // de lijst van vóór je oordeel, en staat je weggetikte event er
      // gewoon weer — dat leest als "mijn nee is niet aangekomen".
      qc.invalidateQueries({ queryKey: ['events', 'new'] });
    },
  });
}

export function useMyDismisses(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.dismisses(),
    queryFn: () => getMyDismisses(),
    enabled: opts.enabled ?? true,
  });
}

export function useMyMirror(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.mirror(),
    queryFn: () => getMyMirror(),
    staleTime: 60_000,
    enabled: opts.enabled ?? true,
  });
}

export function useMirrorByHandle(
  handle: string | null | undefined,
  opts: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: ['mirror', 'u', handle ?? ''] as const,
    queryFn: () => getMirrorByHandle(handle as string),
    enabled: Boolean(handle) && (opts.enabled ?? true),
    staleTime: 60_000,
    retry: (count, err) => {
      // 403/404 zijn permanent — niet retryen, gewoon empty tonen.
      const msg = (err as Error).message ?? '';
      if (/40[34]/.test(msg)) return false;
      return count < 2;
    },
  });
}

export type { Mirror, PublicMirror };

export function useFriends(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.friends(),
    queryFn: () => getFriends(),
    enabled: opts.enabled ?? true,
  });
}

export function useSocialFeed(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.socialFeed(),
    queryFn: () => getSocialFeed(),
    enabled: opts.enabled ?? true,
    // 5 min — feed mag rustig cachen tussen tab-bezoeken; nieuwe
    // saves van vrienden druppelen vanzelf binnen bij volgende fetch.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useFriendRequests(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.friendRequests(),
    queryFn: () => getFriendRequests(),
    enabled: opts.enabled ?? true,
    // Inbox-data moet zo vers mogelijk zijn — geen cache, elke remount
    // (tab-switch, route-push) refetcht. AppState-listener in
    // PushManager invalidateert ook op foreground, en push-receive
    // triggert hetzelfde. Inbox is klein (paar items max) dus de
    // fetch-spam is verwaarloosbaar.
    staleTime: 0,
    refetchOnMount: 'always',
    // Poll elke 60s zodat we 'n nieuw verzoek detecteren ook als de
    // push gemist wordt (no-permission, OEM battery saver, simulator
    // zonder APNS-relay). Pauzeert vanzelf als de app naar background
    // gaat — geen overbelasting.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useOutgoingFriendRequests(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.outgoingFriendRequests(),
    queryFn: () => getOutgoingFriendRequests(),
    enabled: opts.enabled ?? true,
  });
}

export function useUserSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.userSearch(q),
    queryFn: () => searchUsers(q),
    enabled: q.trim().length >= 2,
  });
}

export function useFriend(id: string) {
  return useQuery({
    queryKey: queryKeys.friend(id),
    queryFn: () => getFriendDetail(id),
    enabled: Boolean(id),
  });
}

function invalidateFriendsCaches(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.friends() });
  qc.invalidateQueries({ queryKey: queryKeys.friendRequests() });
  qc.invalidateQueries({ queryKey: queryKeys.outgoingFriendRequests() });
  qc.invalidateQueries({ queryKey: ['user-search'] });
  // Friend-pill data op event-rijen verandert mee als vrienden-set wijzigt.
  qc.invalidateQueries({ queryKey: ['events'] });
  qc.invalidateQueries({ queryKey: ['event'] });
}

export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => sendFriendRequest(handle),
    onSettled: () => invalidateFriendsCaches(qc),
  });
}

export function useAcceptFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fromUserId: string) => acceptFriendRequest(fromUserId),
    onSettled: () => invalidateFriendsCaches(qc),
  });
}

export function useDeclineFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fromUserId: string) => declineFriendRequest(fromUserId),
    onSettled: () => invalidateFriendsCaches(qc),
  });
}

export function useRemoveFriend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeFriend(userId),
    onSettled: () => invalidateFriendsCaches(qc),
  });
}

export function useSetFriendFavorite(friendId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (favorite: boolean) => setFriendFavorite(friendId, favorite),
    onMutate: async (favorite) => {
      await qc.cancelQueries({ queryKey: queryKeys.friend(friendId) });
      const prev = qc.getQueryData<ApiFriendDetail>(queryKeys.friend(friendId));
      if (prev) {
        qc.setQueryData<ApiFriendDetail>(queryKeys.friend(friendId), {
          ...prev,
          favorite,
        });
      }
      return { prev };
    },
    onError: (_err, _fav, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.friend(friendId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.friend(friendId) });
      qc.invalidateQueries({ queryKey: queryKeys.friends() });
    },
  });
}

// ─── Invitations ────────────────────────────────────────────────────

export function useInvitations(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.invitations(),
    queryFn: () => getInvitations(),
    enabled: opts.enabled ?? true,
    // Zelfde reden als useFriendRequests — inbox altijd vers + polling
    // in foreground om gemiste pushes/RSVP's op te vangen.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useSendInvitations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      occurrenceId: string;
      /** Het master-event waar deze occurrence bij hoort — alleen
          gebruikt om de event-detail-cache te invalidaten. */
      eventId: string;
      groupIds?: string[];
      userIds?: string[];
      message?: string;
    }) =>
      sendInvitations({
        occurrenceId: input.occurrenceId,
        groupIds: input.groupIds,
        userIds: input.userIds,
        message: input.message,
      }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations() });
      qc.invalidateQueries({ queryKey: queryKeys.event(vars.eventId) });
    },
  });
}

/** Reageren op een uitnodiging: going / maybe / not_going. Vervangt het
 *  oude accept/decline-paar. */
export function useRespondInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      status: 'going' | 'maybe' | 'not_going';
      replyMessage?: string;
      /** Optionele eventId voor doelgerichte cache-invalidatie van
          de event-detail-page; valt anders terug op brede invalidate. */
      eventId?: string;
    }) =>
      respondInvitation(input.id, {
        status: input.status,
        replyMessage: input.replyMessage,
      }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations() });
      qc.invalidateQueries({ queryKey: queryKeys.saves() });
      if (vars.eventId) {
        qc.invalidateQueries({ queryKey: queryKeys.event(vars.eventId) });
      }
      // Friend-pills op andere events kunnen veranderen omdat ik nu een
      // save voor dit event heb.
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['event'] });
    },
  });
}

/** Stuur eenmalige reminder naar een pending invitee. Server weigert
 *  een tweede call. */
export function useRemindInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { invitationId: string; userId: string; eventId?: string }) =>
      remindInvitation(input.invitationId, input.userId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations() });
      if (vars.eventId) {
        qc.invalidateQueries({ queryKey: queryKeys.event(vars.eventId) });
      }
    },
  });
}

/** Initiator trekt een verstuurde uitnodiging in. */
export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; eventId?: string }) =>
      revokeInvitation(input.id),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invitations() });
      if (vars.eventId) {
        qc.invalidateQueries({ queryKey: queryKeys.event(vars.eventId) });
      }
    },
  });
}

// ─── Groups ─────────────────────────────────────────────────────────

export function useGroups(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.groups(),
    queryFn: () => getGroups(),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
  });
}

export function useGroup(id: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.group(id),
    queryFn: () => getGroup(id),
    enabled: (opts.enabled ?? true) && Boolean(id),
    staleTime: 30_000,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; memberIds: string[] }) =>
      createGroup(input),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
    },
  });
}

export function useRenameGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name: string }) =>
      renameGroup(input.id, input.name),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
      qc.invalidateQueries({ queryKey: queryKeys.group(vars.id) });
    },
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
    },
  });
}

export function useAddGroupMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; userIds: string[] }) =>
      addGroupMembers(input.id, input.userIds),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
      qc.invalidateQueries({ queryKey: queryKeys.group(vars.id) });
    },
  });
}

/** Verlaten (self) of kicken (door creator). Server bepaalt 't op
 *  basis van userId vs current session. */
export function useRemoveGroupMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      removeGroupMember(input.groupId, input.userId),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
      qc.invalidateQueries({ queryKey: queryKeys.group(vars.groupId) });
    },
  });
}

/** Mute toggle — combineert beide endpoints in één hook. */
export function useToggleGroupMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; mute: boolean }) =>
      input.mute ? muteGroup(input.id) : unmuteGroup(input.id),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.groups() });
      qc.invalidateQueries({ queryKey: queryKeys.group(vars.id) });
    },
  });
}

export function useSetVenueFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { venueId: string; state: VenueFollowState }) =>
      setVenueFollow(input),
    onMutate: async ({ venueId, state }) => {
      // Optimistisch: update myFollowState in elke gecachete venue.
      await qc.cancelQueries({ queryKey: ['venue'] });
      const prev = qc.getQueriesData<{
        venue: { id: string };
        myFollowState: VenueFollowState;
      }>({ queryKey: ['venue'] });
      for (const [key, value] of prev) {
        if (value && value.venue.id === venueId) {
          qc.setQueryData(key, { ...value, myFollowState: state });
        }
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx?.prev) return;
      for (const [key, value] of ctx.prev) {
        qc.setQueryData(key, value);
      }
    },
    onSettled: (_data, _err, vars) => {
      // Events lijst kan veranderen (blokken filtert events). Refetch.
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['event'] });
      // Eigen venue-detail. Slug onbekend hier dus invalidate alle venue-keys
      // — tanstack matcht prefix.
      qc.invalidateQueries({ queryKey: ['venue'] });
      qc.invalidateQueries({ queryKey: ['venues'] });
    },
  });
}

