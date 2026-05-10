import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HEADER_HEIGHT } from '@/components/AppHeader';
import { Coachmark } from '@/components/Coachmark';
import { useT } from '@/lib/i18n';
import {
  useDismissContentSwitchHint,
  useHasSeenContentSwitchHint,
} from '@/store/mode';

/**
 * Eerste-bezoek hint die naar de Uit/Expo content-switch in de
 * AppHeader wijst. Verschijnt op Vandaag.
 */
export function ContentSwitchHint() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const hasSeen = useHasSeenContentSwitchHint();
  const dismiss = useDismissContentSwitchHint();

  if (hasSeen) return null;

  return (
    <Coachmark
      // Card-top is `top + arrowWrap.height (11)`. Featured-card-top
      // staat op `paddingTop + marginTop = insets.top + HEADER_HEIGHT
      // + 8`. Voor strakke uitlijning: top = insets.top + HEADER_HEIGHT
      // - 3, dan landt de hint-card op precies dezelfde Y als Featured.
      top={insets.top + HEADER_HEIGHT - 3}
      // Switch in de header: 28px avatar + 8px gap + ~70px switch.
      // Arrow-tip ~56px van rechter rand valt onder de switch.
      arrowFromRight={56}
      title={t('Uitgaan of expo?', 'Going out or expo?')}
      body={t(
        'Tik hierboven om te wisselen tussen uitgaan-content (clubs, podia, theater, film) en kunst & expo. Het bepaalt wat je hier ziet.',
        'Tap above to switch between going-out content (clubs, stages, theatre, film) and art & expo. It changes what you see here.'
      )}
      onDismiss={dismiss}
    />
  );
}
