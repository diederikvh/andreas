import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import {
  getEvent,
  getEvents,
  getMySaves,
  getVenue,
  toggleSave,
  type EventsFilter,
  type SavedApiEvent,
} from '@/lib/api';

export const queryKeys = {
  events: (filter: EventsFilter = {}) => ['events', filter] as const,
  event: (id: string) => ['event', id] as const,
  venue: (slug: string) => ['venue', slug] as const,
  saves: () => ['saves'] as const,
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
