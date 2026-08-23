/**
 * Tone-kleuren per mode — de zes accenten waarmee categorieën en
 * venue-types worden gemarkeerd (ticks, tags, kaart-pins, venue-pills).
 *
 * Stond zes keer los in de codebase: EventListRow plus Vandaag, Agenda,
 * Kaart, Venues en Venue-detail. Bij elke kleurwijziging moest je ze
 * alle zes vinden, en dat gaat een keer mis. Nu één bron.
 *
 * Welke categorie welke tone krijgt staat in `CATEGORY_TICK` en
 * `VENUE_TYPE_TICK` in `lib/eventDisplay.ts` — dat is de mapping; dit
 * zijn de waarden.
 */
import { palette } from './tokens';

export type BadgeToneKey =
  | 'acid'
  | 'flare'
  | 'plum'
  | 'azure'
  | 'saffron'
  | 'cobalt';

export const TONE: Record<'nacht' | 'dag', Record<BadgeToneKey, string>> = {
  nacht: {
    acid: palette.acid,
    flare: palette.flare,
    plum: palette.plum,
    azure: palette.azure,
    saffron: palette.saffron,
    cobalt: palette.cobalt,
  },
  dag: {
    acid: palette.red,
    // Theater. Was `palette.forest` (#2d4a3e), dat op wit bijna zwart
    // leest — als deep-green vlak achter een hero werkt 't nog steeds,
    // maar als label-kleur verliest 't z'n groen. Deze is frisser en
    // houdt genoeg contrast op wit.
    flare: '#1c7a5b',
    plum: palette.cobalt,
    // Film. Was '#8a5b00' — bruin dat op de oude cream-bg als warm oker
    // las maar op wit modderig wordt. Petrol blijft los van plum
    // (cobalt) en cobalt (navy).
    azure: '#0f6e8c',
    // Literatuur. Was '#9d6008', afgedonkerd voor cream-leesbaarheid.
    saffron: '#a8560a',
    // Lezing — dieper navy dan plum zodat Kunst en Lezing uit elkaar
    // blijven.
    cobalt: '#1a3157',
  },
};
