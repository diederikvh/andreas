import { useEffect } from 'react';

import { usePendingEvents } from '@/lib/queries';
import { useTickets } from '@/store/tickets';

/**
 * Je ticket verhuist mee als je aanmelding een echt event wordt.
 *
 * Een ticket hangt aan een sleutel: bij een aanmelding is dat `sub-…`, bij
 * een echt event de occurrence. Zodra een mens (of straks de koppeling
 * zelf) er een event van maakt, verspringt je plan naar dat event — en
 * bleef het kaartje achter op een sleutel die nergens meer in beeld komt.
 * Het bestand was niet weg, maar je kon er niet meer bij.
 *
 * Hier, en niet in het scherm dat de lijst toont: de verhuizing moet ook
 * gebeuren als je nooit op Agenda of Gered kijkt. De query is dezelfde als
 * elders (react-query deelt 'm), dus dit kost geen extra verkeer.
 *
 * Het bestand blijft staan waar het staat. Alleen de sleutel verandert.
 */
export function TicketRehome() {
  const { data: pending } = usePendingEvents();
  const move = useTickets((s) => s.move);
  const hydrated = useTickets((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated || !pending) return;
    const tickets = useTickets.getState().tickets;
    for (const item of pending) {
      const to = item.linkedOccurrenceId;
      if (!to) continue;
      if ((tickets[item.id]?.length ?? 0) === 0) continue;
      move(item.id, to);
    }
  }, [pending, hydrated, move]);

  return null;
}
