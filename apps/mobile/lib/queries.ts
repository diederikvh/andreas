import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import {
  acceptFriendRequest,
  acceptInvite,
  declineFriendRequest,
  declineInvite,
  getEvent,
  getEventGenres,
  getEvents,
  getFriendDetail,
  getFriendRequests,
  getFriends,
  getInvites,
  getOutgoingFriendRequests,
  getMySaves,
  getSeries,
  getSeriesList,
  getVenue,
  getVenueSubtypes,
  getVenues,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  sendInvites,
  setVenueFollow,
  toggleSave,
  type EventsFilter,
  type SavedApiEvent,
  type VenueCategory,
  type VenueFollowState,
  type VenueType,
} from '@/lib/api';

export const queryKeys = {
  events: (filter: EventsFilter = {}) => ['events', filter] as const,
  event: (id: string) => ['event', id] as const,
  eventGenres: () => ['event-genres'] as const,
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
  invites: () => ['invites'] as const,
};

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

export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.event(id),
    queryFn: () => getEvent(id),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: true,
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
  category?: 'Muziek' | 'Theater' | 'Literatuur' | 'Film' | 'Kunst';
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
  input: { q?: string; category?: VenueCategory } = {}
) {
  return useQuery({
    queryKey: queryKeys.seriesList({ q: input.q, category: input.category }),
    queryFn: () => getSeriesList(input),
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

export function useToggleSave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => toggleSave(eventId),
    onMutate: async (eventId) => {
      await qc.cancelQueries({ queryKey: queryKeys.saves() });
      const prev = qc.getQueryData<SavedApiEvent[]>(queryKeys.saves());
      // Optimistic: verwijder als aanwezig, anders niets toevoegen
      // (we hebben hier het volledige event-object niet; volledige
      // refresh komt via onSettled).
      if (prev) {
        qc.setQueryData<SavedApiEvent[]>(
          queryKeys.saves(),
          prev.filter((e) => e.id !== eventId)
        );
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.saves(), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.saves() });
    },
  });
}

export function useFriends(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.friends(),
    queryFn: () => getFriends(),
    enabled: opts.enabled ?? true,
  });
}

export function useFriendRequests(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.friendRequests(),
    queryFn: () => getFriendRequests(),
    enabled: opts.enabled ?? true,
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

// ─── Invites ────────────────────────────────────────────────────────

export function useInvites(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.invites(),
    queryFn: () => getInvites(),
    enabled: opts.enabled ?? true,
  });
}

export function useSendInvites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      occurrenceId: string;
      /** Het master-event waar deze occurrence bij hoort — alleen
          gebruikt om de event-detail-cache te invalidaten. */
      eventId: string;
      toUserIds: string[];
      message?: string;
    }) =>
      sendInvites({
        occurrenceId: input.occurrenceId,
        toUserIds: input.toUserIds,
        message: input.message,
      }),
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.invites() });
      // Inviter ziet `myInvites` op event-detail — refreshen zodat de
      // nieuwe rijen direct verschijnen.
      qc.invalidateQueries({ queryKey: queryKeys.event(vars.eventId) });
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => acceptInvite(id),
    onSettled: (data) => {
      qc.invalidateQueries({ queryKey: queryKeys.invites() });
      qc.invalidateQueries({ queryKey: queryKeys.saves() });
      if (data?.eventId) {
        qc.invalidateQueries({ queryKey: queryKeys.event(data.eventId) });
      }
      // Friend-pills op andere events kunnen veranderen omdat ik nu een
      // save voor dit event heb.
      qc.invalidateQueries({ queryKey: ['events'] });
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

export function useDeclineInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => declineInvite(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.invites() });
      // Inviter's myInvites wordt geüpdatet bij de volgende fetch van
      // het event — geen specifieke eventId beschikbaar hier.
      qc.invalidateQueries({ queryKey: ['event'] });
    },
  });
}
