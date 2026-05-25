import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_HEIGHT } from '@/components/AppHeader';
import { Coachmark } from '@/components/Coachmark';
import { useT } from '@/lib/i18n';
import {
  useDismissFilterHint,
  useHasSeenFilterHint,
} from '@/store/mode';

const CHIPROW_HEIGHT = 60;

/**
 * Eerste-bezoek hint op Agenda: wijst naar de filter-knop in de
 * chip-row. Belangrijke nadruk op de bewaar-functie — anders missen
 * gebruikers dat ze filter-combinaties kunnen opslaan als chip.
 */
export function FilterHint() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const hasSeen = useHasSeenFilterHint();
  const dismiss = useDismissFilterHint();

  if (hasSeen) return null;

  return (
    <Coachmark
      // Y: arrow net onder de chip-row zodat 'ie naar de filter-knop
      // wijst; de card legt zich daardoor ovér de day-strip heen
      // (mag — die mag verstopt worden door de hint). -7 compenseert
      // voor arrowWrap-hoogte van Coachmark.
      top={insets.top + HEADER_HEIGHT + CHIPROW_HEIGHT - 7}
      // X: filter-knop staat links in de chipRow, tweede element na de
      // search-chip. Vanaf rechts gemeten ligt 'ie ongeveer ~250px van
      // de rechterrand op een 390px-scherm.
      arrowFromRight={250}
      title={t('Filter & bewaar', 'Filter & save')}
      body={t(
        'Tik op de filter-knop om te filteren op categorie, genre, tijd of venue. Tip: je kunt een combinatie opslaan zodat-ie als chip naast de filter-knop verschijnt — handig voor je vaste smaak.',
        'Tap the filter button to filter by category, genre, time or venue. Tip: save a combination so it appears as a chip next to the filter button — handy for recurring tastes.'
      )}
      onDismiss={dismiss}
    />
  );
}
