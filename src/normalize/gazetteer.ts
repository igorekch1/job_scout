/**
 * Small built-in gazetteer: enough to read the location lines of remote job postings.
 * Extend it per installation with `filters.location.extra_aliases`.
 *
 * Aliases written in UPPERCASE and up to four letters long ("US", "UK", "EU", "UAE") are
 * matched case-sensitively, because their lowercase forms are ordinary words.
 */

type CountryEntry = readonly [iso: string, ...aliases: string[]];

const COUNTRIES: readonly CountryEntry[] = [
  ['US', 'united states', 'united states of america', 'USA', 'US', 'U.S.', 'U.S.A.'],
  ['CA', 'canada'],
  ['MX', 'mexico'],
  ['GB', 'united kingdom', 'UK', 'U.K.', 'great britain', 'england', 'scotland', 'wales'],
  ['IE', 'ireland'],
  ['DE', 'germany', 'deutschland'],
  ['FR', 'france'],
  ['ES', 'spain'],
  ['PT', 'portugal'],
  ['IT', 'italy'],
  ['NL', 'netherlands', 'the netherlands', 'holland'],
  ['BE', 'belgium'],
  ['LU', 'luxembourg'],
  ['CH', 'switzerland'],
  ['AT', 'austria'],
  ['SE', 'sweden'],
  ['NO', 'norway'],
  ['DK', 'denmark'],
  ['FI', 'finland'],
  ['IS', 'iceland'],
  ['PL', 'poland'],
  ['CZ', 'czech republic', 'czechia'],
  ['SK', 'slovakia'],
  ['HU', 'hungary'],
  ['RO', 'romania'],
  ['BG', 'bulgaria'],
  ['GR', 'greece'],
  ['HR', 'croatia'],
  ['SI', 'slovenia'],
  ['RS', 'serbia'],
  ['EE', 'estonia'],
  ['LV', 'latvia'],
  ['LT', 'lithuania'],
  ['UA', 'ukraine'],
  ['MD', 'moldova'],
  ['BY', 'belarus'],
  ['RU', 'russia', 'russian federation'],
  ['GE', 'republic of georgia', 'tbilisi'],
  ['AM', 'armenia'],
  ['KZ', 'kazakhstan'],
  ['TR', 'turkey', 'türkiye'],
  ['CY', 'cyprus'],
  ['MT', 'malta'],
  ['IL', 'israel'],
  ['AE', 'united arab emirates', 'UAE'],
  ['SA', 'saudi arabia'],
  ['EG', 'egypt'],
  ['ZA', 'south africa'],
  ['NG', 'nigeria'],
  ['KE', 'kenya'],
  ['IN', 'india'],
  ['PK', 'pakistan'],
  ['BD', 'bangladesh'],
  ['LK', 'sri lanka'],
  ['CN', 'china'],
  ['HK', 'hong kong'],
  ['TW', 'taiwan'],
  ['JP', 'japan'],
  ['KR', 'south korea', 'korea'],
  ['SG', 'singapore'],
  ['MY', 'malaysia'],
  ['TH', 'thailand'],
  ['VN', 'vietnam'],
  ['PH', 'philippines'],
  ['ID', 'indonesia'],
  ['AU', 'australia'],
  ['NZ', 'new zealand'],
  ['BR', 'brazil', 'brasil'],
  ['AR', 'argentina'],
  ['CL', 'chile'],
  ['CO', 'colombia'],
  ['PE', 'peru'],
  ['UY', 'uruguay'],
  ['CR', 'costa rica'],
];

/** Major hiring hubs, so that "Berlin" or "New York" resolves to a country. */
const CITIES: Readonly<Record<string, string>> = {
  'new york': 'US',
  'san francisco': 'US',
  'los angeles': 'US',
  seattle: 'US',
  austin: 'US',
  atlanta: 'US',
  boston: 'US',
  chicago: 'US',
  denver: 'US',
  toronto: 'CA',
  vancouver: 'CA',
  montreal: 'CA',
  london: 'GB',
  manchester: 'GB',
  dublin: 'IE',
  berlin: 'DE',
  munich: 'DE',
  hamburg: 'DE',
  paris: 'FR',
  madrid: 'ES',
  barcelona: 'ES',
  lisbon: 'PT',
  amsterdam: 'NL',
  zurich: 'CH',
  vienna: 'AT',
  stockholm: 'SE',
  copenhagen: 'DK',
  warsaw: 'PL',
  krakow: 'PL',
  prague: 'CZ',
  budapest: 'HU',
  bucharest: 'RO',
  'tel aviv': 'IL',
  dubai: 'AE',
  bangalore: 'IN',
  bengaluru: 'IN',
  hyderabad: 'IN',
  mumbai: 'IN',
  pune: 'IN',
  tokyo: 'JP',
  sydney: 'AU',
  melbourne: 'AU',
  'sao paulo': 'BR',
  'são paulo': 'BR',
  'buenos aires': 'AR',
  'mexico city': 'MX',
};

const US_STATES = [
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington state',
  'west virginia',
  'wisconsin',
  'wyoming',
];

const EU = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]; // prettier-ignore
const EUROPE = [...EU, 'GB', 'CH', 'NO', 'IS', 'UA', 'MD', 'RS', 'BY', 'TR', 'GE', 'AM'];
const MIDDLE_EAST = ['IL', 'AE', 'SA', 'TR', 'EG', 'CY'];
const AFRICA = ['ZA', 'NG', 'KE', 'EG'];
const NORTH_AMERICA = ['US', 'CA', 'MX'];
const LATAM = ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'CR'];
const ASIA = ['IN', 'PK', 'BD', 'LK', 'CN', 'HK', 'TW', 'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'PH', 'ID', 'KZ']; // prettier-ignore
const OCEANIA = ['AU', 'NZ'];

export interface Region {
  id: string;
  aliases: readonly string[];
  /** Member countries. "all" for worldwide; empty for time-zone style regions. */
  members: readonly string[] | 'all';
}

export const REGIONS: readonly Region[] = [
  {
    id: 'worldwide',
    aliases: ['worldwide', 'anywhere', 'global', 'globally', 'work from anywhere', 'all countries'],
    members: 'all',
  },
  { id: 'europe', aliases: ['europe', 'european'], members: EUROPE },
  { id: 'eu', aliases: ['EU', 'E.U.', 'european union', 'EEA'], members: [...EU, 'NO', 'IS'] },
  { id: 'emea', aliases: ['EMEA'], members: [...new Set([...EUROPE, ...MIDDLE_EAST, ...AFRICA])] },
  { id: 'dach', aliases: ['DACH'], members: ['DE', 'AT', 'CH'] },
  {
    id: 'nordics',
    aliases: ['nordics', 'nordic', 'scandinavia'],
    members: ['SE', 'NO', 'DK', 'FI', 'IS'],
  },
  { id: 'benelux', aliases: ['benelux'], members: ['BE', 'NL', 'LU'] },
  { id: 'baltics', aliases: ['baltics', 'baltic states'], members: ['EE', 'LV', 'LT'] },
  {
    id: 'cee',
    aliases: ['CEE', 'central and eastern europe', 'eastern europe', 'central europe'],
    members: ['PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'RS', 'UA', 'MD', 'EE', 'LV', 'LT'],
  },
  {
    id: 'north-america',
    aliases: ['north america', 'NAMER', 'NORAM', 'US/Canada', 'US & Canada', 'US and Canada'],
    members: NORTH_AMERICA,
  },
  { id: 'latam', aliases: ['LATAM', 'latin america', 'south america'], members: LATAM },
  {
    id: 'americas',
    aliases: ['americas', 'AMER'],
    members: [...new Set([...NORTH_AMERICA, ...LATAM])],
  },
  { id: 'apac', aliases: ['APAC', 'asia pacific', 'asia-pacific'], members: [...ASIA, ...OCEANIA] },
  { id: 'asia', aliases: ['asia'], members: ASIA },
  { id: 'oceania', aliases: ['oceania', 'ANZ'], members: OCEANIA },
  { id: 'middle-east', aliases: ['middle east', 'MENA'], members: MIDDLE_EAST },
  { id: 'africa', aliases: ['africa'], members: AFRICA },
  // Time-zone style "regions" carry no members: they match only through filters.location.allowed_regions.
  { id: 'cet', aliases: ['CET', 'CEST', 'central european time'], members: [] },
  { id: 'eet', aliases: ['EET', 'EEST', 'eastern european time'], members: [] },
  { id: 'us-timezones', aliases: ['US time zones', 'US timezones', 'US hours'], members: [] },
];

export type PlaceKind = 'country' | 'region';

export interface PlaceAlias {
  alias: string;
  kind: PlaceKind;
  id: string;
}

const builtIn: PlaceAlias[] = [
  ...COUNTRIES.flatMap(([iso, ...aliases]) =>
    aliases.map((alias): PlaceAlias => ({ alias, kind: 'country', id: iso })),
  ),
  ...Object.entries(CITIES).map(([alias, iso]): PlaceAlias => ({
    alias,
    kind: 'country',
    id: iso,
  })),
  ...US_STATES.map((alias): PlaceAlias => ({ alias, kind: 'country', id: 'US' })),
  ...REGIONS.flatMap((region) =>
    region.aliases.map((alias): PlaceAlias => ({ alias, kind: 'region', id: region.id })),
  ),
];

const regionById = new Map(REGIONS.map((region) => [region.id, region]));
const knownCountries = new Set(COUNTRIES.map(([iso]) => iso));

export const isRegionId = (id: string): boolean => regionById.has(id);

/** True when `country` belongs to the region. Unknown regions contain nothing. */
export function regionContains(regionId: string, country: string): boolean {
  const region = regionById.get(regionId);
  if (!region) return false;
  return region.members === 'all' || region.members.includes(country);
}

/** Resolves a user-supplied region or alias ("Europe", "emea") to a region id. */
export function resolveRegion(name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  if (regionById.has(wanted)) return wanted;
  return REGIONS.find((region) => region.aliases.some((alias) => alias.toLowerCase() === wanted))
    ?.id;
}

/**
 * Built-in aliases plus user-defined ones. Each extra alias maps a place name to an ISO
 * country code or a region id.
 */
export function buildAliases(extra: Readonly<Record<string, string>> = {}): PlaceAlias[] {
  const custom = Object.entries(extra).map(([alias, target]): PlaceAlias => {
    const region = resolveRegion(target);
    if (region) return { alias, kind: 'region', id: region };
    return { alias, kind: 'country', id: target.trim().toUpperCase() };
  });
  return [...custom, ...builtIn];
}

export const isKnownCountry = (iso: string): boolean => knownCountries.has(iso);
