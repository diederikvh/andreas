import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef } from 'react';

/**
 * Filter-state-management voor schermen waar je een filter zet en dan
 * naar detail wilt drillen (Agenda → /event/[id], Venues → /venue/[slug]).
 *
 * Gedrag (matcht Spotify Search / X / YouTube):
 *  - Stack-push (tap op een rij → detail-screen, swipe-back): filter
 *    blijft intact. Je verfijning is een onderdeel van je zoekpad.
 *  - Tab-wissel (naar Vandaag/Sociaal/etc): filter reset. Een nieuwe
 *    context = clean slate.
 *
 * Implementatie: caller MOET `markStackPush()` aanroepen vóór elke
 * `router.push(...)` naar een detail-screen. Als de blur fired zonder
 * dat de vlag gezet is, vatten we 'm op als tab-wissel en resetten.
 *
 * Voorbeeld:
 *   const markPush = useResetFiltersOnTabBlur(useAgendaFilters((s) => s.reset));
 *   const onTap = (path: string) => { markPush(); router.push(path); };
 */
export function useResetFiltersOnTabBlur(reset: () => void) {
  const stackPushRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (stackPushRef.current) {
          // Consume — volgende blur is weer "onbekend tot bewezen".
          stackPushRef.current = false;
        } else {
          reset();
        }
      };
    }, [reset])
  );

  return useCallback(() => {
    stackPushRef.current = true;
  }, []);
}
