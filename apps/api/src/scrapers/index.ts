import { scrapeIcal, type IcalVenueResult } from './ical.js';
import { scrapeJsonLd, type JsonLdVenueResult } from './jsonld.js';
import { scrapeMelkweg, type MelkwegResult } from './melkweg.js';
import { scrapeParadiso, type ParadisoResult } from './paradiso.js';
import { scrapeStager, type StagerVenueResult } from './stager.js';
import { scrapeWpTheatre, type WpTheatreResult } from './wptheatre.js';
import { scrapeZiggodome, type ZiggodomeResult } from './ziggodome.js';

/**
 * Registry van alle scrapers. Sleutels matchen met `venues.scraperConfig`-
 * keys waar mogelijk; venue-specifieke scrapers (ziggodome, melkweg,
 * paradiso) hebben hun eigen ingang.
 */
export const scrapers = {
  stager: scrapeStager,
  ical: scrapeIcal,
  jsonld: scrapeJsonLd,
  ziggodome: scrapeZiggodome,
  melkweg: scrapeMelkweg,
  paradiso: scrapeParadiso,
  wptheatre: scrapeWpTheatre,
} as const;

export type ScraperName = keyof typeof scrapers;

export type ScraperResult =
  | StagerVenueResult
  | IcalVenueResult
  | JsonLdVenueResult
  | ZiggodomeResult
  | MelkwegResult
  | ParadisoResult
  | WpTheatreResult;
