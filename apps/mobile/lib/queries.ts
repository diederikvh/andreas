import { useQuery } from '@tanstack/react-query';

import { getEvent, getEvents, getVenue } from '@/lib/api';

export const queryKeys = {
  events: () => ['events'] as const,
  event: (id: string) => ['event', id] as const,
  venue: (slug: string) => ['venue', slug] as const,
};

export function useEvents() {
  return useQuery({
    queryKey: queryKeys.events(),
    queryFn: () => getEvents(),
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
