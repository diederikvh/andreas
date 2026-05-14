import { scrapeArti, type ArtiResult } from './arti.js';
import { scrapeBadhuistheater, type BadhuistheaterResult } from './badhuistheater.js';
import { scrapeBettyAsfalt, type BettyAsfaltResult } from './bettyasfalt.js';
import { scrapeBimhuis, type BimhuisResult } from './bimhuis.js';
import { scrapeBourbonStreet, type BourbonStreetResult } from './bourbonstreet.js';
import { scrapeTheaterMascini, type TheaterMasciniResult } from './theatermascini.js';
import { scrapeCbkZuidoost, type CbkZuidoostResult } from './cbkzuidoost.js';
import { scrapeDeNieuweAnita, type DeNieuweAnitaResult } from './denieuweanita.js';
import { scrapeNxtMuseum, type NxtMuseumResult } from './nxtmuseum.js';
import { scrapeRijksmuseum, type RijksmuseumResult } from './rijksmuseum.js';
import { scrapeCobraMuseum, type CobraMuseumResult } from './cobramuseum.js';
import { scrapeAmsterdamMuseum, type AmsterdamMuseumResult } from './amsterdammuseum.js';
import { scrapeWereldmuseum, type WereldmuseumResult } from './wereldmuseum.js';
import { scrapeVanGoghMuseum, type VanGoghMuseumResult } from './vangoghmuseum.js';
import { scrapeFoam, type FoamResult } from './foam.js';
import { scrapeOudeKerk, type OudeKerkResult } from './oudekerk.js';
import { scrapeBoomChicago, type BoomChicagoResult } from './boomchicago.js';
import { scrapeBrakkeGrond, type BrakkeGrondResult } from './brakkegrond.js';
import { scrapeCelebratix, type CelebratixVenueResult } from './celebratix.js';
import { scrapeConcertgemaal, type ConcertgemaalResult } from './concertgemaal.js';
import {
  scrapeEventsCalendar,
  type EventsCalendarVenueResult,
} from './eventscalendar.js';
import { scrapeFourvenues, type FourvenuesResult } from './fourvenues.js';
import { scrapeGarageNoord, type GarageNoordResult } from './garagenoord.js';
import { scrapeIta, type ItaResult } from './ita.js';
import { scrapeKrakeling, type KrakelingResult } from './krakeling.js';
import { scrapeOperaballet, type OperaballetResult } from './operaballet.js';
import { scrapeOt301, type Ot301Result } from './ot301.js';
import { scrapePodiumMozaiek, type PodiumMozaiekResult } from './podiummozaiek.js';
import { scrapeQFactory, type QFactoryResult } from './qfactory.js';
import { scrapeThuishaven, type ThuishavenResult } from './thuishaven.js';
import { scrapeWeeztix, type WeeztixVenueResult } from './weeztix.js';
import { scrapeIcal, type IcalVenueResult } from './ical.js';
import { scrapeJsonLd, type JsonLdVenueResult } from './jsonld.js';
import { scrapeMelkweg, type MelkwegResult } from './melkweg.js';
import { scrapeMuziekgebouw, type MuziekgebouwResult } from './muziekgebouw.js';
import { scrapeOnTheRoof, type OnTheRoofResult } from './ontheroof.js';
import { scrapeP60, type P60Result } from './p60.js';
import { scrapeParadiso, type ParadisoResult } from './paradiso.js';
import { scrapePatronaat, type PatronaatResult } from './patronaat.js';
import { scrapeRadioRadio, type RadioRadioResult } from './radioradio.js';
import { scrapeShelter, type ShelterResult } from './shelter.js';
import { scrapeSieraad, type SieraadResult } from './sieraad.js';
import { scrapeStager, type StagerVenueResult } from './stager.js';
import { scrapeTheater, type TheaterVenueResult } from './theater.js';
import { scrapeTicketmaster, type TicketmasterVenueResult } from './ticketmaster.js';
import { scrapeVolkshotel, type VolkshotelVenueResult } from './volkshotel.js';
import { scrapeWeticket, type WeticketVenueResult } from './weticket.js';
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
  patronaat: scrapePatronaat,
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
  weeztix: scrapeWeeztix,
  fourvenues: scrapeFourvenues,
  shelter: scrapeShelter,
  radioradio: scrapeRadioRadio,
  sieraad: scrapeSieraad,
  garagenoord: scrapeGarageNoord,
  weticket: scrapeWeticket,
  krakeling: scrapeKrakeling,
  eventscalendar: scrapeEventsCalendar,
  volkshotel: scrapeVolkshotel,
  arti: scrapeArti,
  cbkzuidoost: scrapeCbkZuidoost,
  nxtmuseum: scrapeNxtMuseum,
  rijksmuseum: scrapeRijksmuseum,
  cobramuseum: scrapeCobraMuseum,
  amsterdammuseum: scrapeAmsterdamMuseum,
  wereldmuseum: scrapeWereldmuseum,
  vangoghmuseum: scrapeVanGoghMuseum,
  foam: scrapeFoam,
  oudekerk: scrapeOudeKerk,
  bettyasfalt: scrapeBettyAsfalt,
  bourbonstreet: scrapeBourbonStreet,
  theatermascini: scrapeTheaterMascini,
  denieuweanita: scrapeDeNieuweAnita,
  badhuistheater: scrapeBadhuistheater,
} as const;

export type ScraperName = keyof typeof scrapers;

export type ScraperResult =
  | StagerVenueResult
  | IcalVenueResult
  | JsonLdVenueResult
  | ZiggodomeResult
  | MelkwegResult
  | ParadisoResult
  | PatronaatResult
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
  | CelebratixVenueResult
  | WeeztixVenueResult
  | FourvenuesResult
  | ShelterResult
  | RadioRadioResult
  | SieraadResult
  | GarageNoordResult
  | WeticketVenueResult
  | KrakelingResult
  | EventsCalendarVenueResult
  | VolkshotelVenueResult
  | ArtiResult
  | CbkZuidoostResult
  | NxtMuseumResult
  | RijksmuseumResult
  | CobraMuseumResult
  | AmsterdamMuseumResult
  | WereldmuseumResult
  | VanGoghMuseumResult
  | FoamResult
  | OudeKerkResult
  | BettyAsfaltResult
  | BourbonStreetResult
  | TheaterMasciniResult
  | DeNieuweAnitaResult
  | BadhuistheaterResult;
