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
  getEvents,
  getFriendDetail,
  getFriendRequests,
  getFriends,
  getInvites,
  getOutgoingFriendRequests,
  getMySaves,
  getVenue,
  removeFriend,
  searchUsers,
  sendFriendRequest,
  sendInvites,
  toggleSave,
  type EventsFilter,
  type SavedApiEvent,
} from '@/lib/api';

export const queryKeys = {
  events: (filter: EventsFilter = {}) => ['events', filter] as const,
  event: (id: string) => ['event', id] as const,
  venue: (slug: string) => ['venue', slug] as const,
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
  });
}

export function useEvent(id: string) {
  return useQuery({
    queryKey: queryKeys.event(id),
    queryFn: () => getEvent(id),
    enabled: Boolean(id),
  });
}

export function useVenue(slug: string) {
  return useQuery({
    queryKey: queryKeys.venue(slug),
    queryFn: () => getVenue(slug),
    enabled: Boolean(slug),
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
      eventId: string;
      toUserIds: string[];
      message?: string;
    }) => sendInvites(input),
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
