import { scrapeBimhuis, type BimhuisResult } from './bimhuis.js';
import { scrapeBoomChicago, type BoomChicagoResult } from './boomchicago.js';
import { scrapeBrakkeGrond, type BrakkeGrondResult } from './brakkegrond.js';
import { scrapeCelebratix, type CelebratixVenueResult } from './celebratix.js';
import { scrapeConcertgemaal, type ConcertgemaalResult } from './concertgemaal.js';
import { scrapeIta, type ItaResult } from './ita.js';
import { scrapeOperaballet, type OperaballetResult } from './operaballet.js';
import { scrapeOt301, type Ot301Result } from './ot301.js';
import { scrapePodiumMozaiek, type PodiumMozaiekResult } from './podiummozaiek.js';
import { scrapeQFactory, type QFactoryResult } from './qfactory.js';
import { scrapeThuishaven, type ThuishavenResult } from './thuishaven.js';
import { scrapeIcal, type IcalVenueResult } from './ical.js';
import { scrapeJsonLd, type JsonLdVenueResult } from './jsonld.js';
import { scrapeMelkweg, type MelkwegResult } from './melkweg.js';
import { scrapeMuziekgebouw, type MuziekgebouwResult } from './muziekgebouw.js';
import { scrapeOnTheRoof, type OnTheRoofResult } from './ontheroof.js';
import { scrapeP60, type P60Result } from './p60.js';
import { scrapeParadiso, type ParadisoResult } from './paradiso.js';
import { scrapeStager, type StagerVenueResult } from './stager.js';
import { scrapeTheater, type TheaterVenueResult } from './theater.js';
import { scrapeTicketmaster, type TicketmasterVenueResult } from './ticketmaster.js';
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
  muziekgebouw: scrapeMuziekgebouw,
  ontheroof: scrapeOnTheRoof,
  p60: scrapeP60,
  concertgemaal: scrapeConcertgemaal,
  ticketmaster: scrapeTicketmaster,
  theater: scrapeTheater,
  boomchicago: scrapeBoomChicago,
  bimhuis: scrapeBimhuis,
  ita: scrapeIta,
  operaballet: scrapeOperaballet,
  ot301: scrapeOt301,
  podiummozaiek: scrapePodiumMozaiek,
  brakkegrond: scrapeBrakkeGrond,
  qfactory: scrapeQFactory,
  thuishaven: scrapeThuishaven,
  celebratix: scrapeCelebratix,
} as const;

export type ScraperName = keyof typeof scrapers;

export type ScraperResult =
  | StagerVenueResult
  | IcalVenueResult
  | JsonLdVenueResult
  | ZiggodomeResult
  | MelkwegResult
  | ParadisoResult
  | WpTheatreResult
  | MuziekgebouwResult
  | OnTheRoofResult
  | P60Result
  | ConcertgemaalResult
  | TicketmasterVenueResult
  | TheaterVenueResult
  | BoomChicagoResult
  | BimhuisResult
  | ItaResult
  | OperaballetResult
  | Ot301Result
  | PodiumMozaiekResult
  | BrakkeGrondResult
  | QFactoryResult
  | ThuishavenResult
  | CelebratixVenueResult;
