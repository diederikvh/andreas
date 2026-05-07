import { scrapeStager, type StagerVenueResult } from './stager.js';

/**
 * Registry van alle scrapers. Sleutels matchen met `venues.scraperConfig`-
 * keys: een venue met `scraperConfig.stager` wordt door de stager-runner
 * opgepakt. Volgende scrapers (eventbrite, rss, ical) plug-and-play.
 */
export const scrapers = {
  stager: scrapeStager,
} as const;

export type ScraperName = keyof typeof scrapers;

export type ScraperResult = StagerVenueResult;
