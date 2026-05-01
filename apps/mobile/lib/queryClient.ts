import { QueryClient } from '@tanstack/react-query';

/**
 * Single QueryClient voor de hele app. Mounted in `app/_layout.tsx`.
 * Defaults zijn iets meer relaxed dan TanStack's standaard:
 *  - 30s staleTime zodat we niet bij elke focus refetchen
 *  - retry 1 zodat een korte hapering niet meteen een error toont
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
