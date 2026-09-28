import { router } from 'expo-router';

import { EventListRow } from '@/components/EventListRow';
import type { ApiFollowedShow } from '@/lib/api';
import {
  CATEGORY_TICK,
  VENUE_TYPE_TICK,
  dowMixed,
  monthShort,
  rowTimeLabel,
  translateCategory,
} from '@/lib/eventDisplay';
import { useLocale, useT } from '@/lib/i18n';
import type { BadgeToneKey } from '@/theme/tones';

/** Een komende avond van een artiest die je volgt: gedeeld door de pagina
    "Komt eraan" en (vroeger) het tabblad op Artiesten. */
export function FollowedShowRow({ show }: { show: ApiFollowedShow }) {
  const locale = useLocale();
  const t = useT();
  const venueTone =
    show.venue.type &&
    (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[show.venue.type]
      ? (VENUE_TYPE_TICK as Record<string, BadgeToneKey>)[show.venue.type]
      : undefined;
  const tone = CATEGORY_TICK[show.category];
  // Een rij mag niet omvallen op een datum die niet te lezen is. Dat
  // gebeurde met een gecachet antwoord van vóór een serverfix: de datum
  // kwam als "2026-09-25 21:00:00+00" en JavaScriptCore op iOS maakt daar
  // een Invalid Date van. De server stuurt nu ISO, maar een scherm dat
  // crasht op oude data in de cache is alsnog stuk.
  const d = new Date(show.occurrence.startsAt);
  const dateLabel = Number.isNaN(d.getTime())
    ? undefined
    : `${dowMixed(d.getDay(), locale)} ${d.getDate()} ${monthShort(
        d.getMonth(),
        locale,
      ).toLowerCase()}`;

  return (
    <EventListRow
      thumb={show.imageUrl ?? ''}
      thumbSize={96}
      title={show.title}
      venue={show.venue.name}
      venueTone={venueTone}
      time={rowTimeLabel(show.occurrence.startsAt, show.occurrence.endsAt, locale)}
      dateLabel={dateLabel}
      dateAbove
      tags={[{ label: translateCategory(show.category, locale), tone }]}
      // Waarom deze avond hier staat. Zonder dat is het een willekeurige
      // rij tussen je andere lijsten.
      genreLabel={
        show.role === 'werk_van'
          ? `${show.artistName} · ${t('werk van', 'work by')}`
          : show.role === 'covers'
            ? `${show.artistName} · ${t('covers', 'covers')}`
          : show.tribute
            ? `${show.artistName} · tribute`
            : show.artistName
      }
      tick={tone}
      onPress={() =>
        router.push(
          `/event/${show.id}?source=other&o=${show.occurrence.id}` as never,
        )
      }
    />
  );
}
