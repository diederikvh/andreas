import { scrapeIcal, type IcalVenueResult } from './ical.js';
import { scrapeJsonLd, type JsonLdVenueResult } from './jsonld.js';
import { scrapeStager, type StagerVenueResult } from './stager.js';

/**
 * Registry van alle scrapers. Sleutels matchen met `venues.scraperConfig`-
 * keys: een venue met `scraperConfig.stager` wordt door de stager-runner
 * opgepakt. Volgende scrapers (eventbrite, rss) plug-and-play.
 */
export const scrapers = {
  stager: scrapeStager,
  ical: scrapeIcal,
  jsonld: scrapeJsonLd,
} as const;

export type ScraperName = keyof typeof scrapers;

export type ScraperResult =
  | StagerVenueResult
  | IcalVenueResult
  | JsonLdVenueResult;
