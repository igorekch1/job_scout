import { keywordRegex } from '../util/text.js';
import { buildAliases, type PlaceAlias } from './gazetteer.js';
import type { JobLocation, WorkMode } from './job.js';

export interface PlaceMatches {
  countries: string[];
  regions: string[];
}

const DEFAULT_ALIASES = buildAliases();

/** Short all-caps aliases ("US", "UK", "EU") are ordinary words in lowercase, so match case. */
const isCaseSensitive = (alias: string): boolean =>
  alias === alias.toUpperCase() && alias.replace(/[^A-Za-z]/g, '').length <= 3;

const sortedCache = new WeakMap<readonly PlaceAlias[], PlaceAlias[]>();

function longestFirst(aliases: readonly PlaceAlias[]): PlaceAlias[] {
  let sorted = sortedCache.get(aliases);
  if (!sorted) {
    sorted = [...aliases].sort((a, b) => b.alias.length - a.alias.length);
    sortedCache.set(aliases, sorted);
  }
  return sorted;
}

/**
 * Finds every known country and region in a piece of text. Longer names win, so
 * "European Union" is the EU and not Europe, and "New Mexico" is not Mexico.
 */
export function findPlaces(
  text: string,
  aliases: readonly PlaceAlias[] = DEFAULT_ALIASES,
): PlaceMatches {
  const countries = new Set<string>();
  const regions = new Set<string>();
  let remaining = text;

  for (const entry of longestFirst(aliases)) {
    const regex = keywordRegex(entry.alias, isCaseSensitive(entry.alias) ? 'gu' : 'giu');
    let found = false;
    remaining = remaining.replace(regex, (match) => {
      found = true;
      return ' '.repeat(match.length);
    });
    if (found) (entry.kind === 'country' ? countries : regions).add(entry.id);
  }

  return { countries: [...countries].sort(), regions: [...regions].sort() };
}

const REMOTE =
  /\b(remote(?:ly)?|distributed|work(?:ing)? from home|wfh|home[- ]based|telecommute|anywhere|worldwide)\b/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\b(on[- ]?site|in[- ]office|office[- ]based|in[- ]person)\b/i;

export function detectWorkMode(text: string): WorkMode | null {
  if (REMOTE.test(text)) return 'remote';
  if (HYBRID.test(text)) return 'hybrid';
  if (ONSITE.test(text)) return 'onsite';
  return null;
}

/** Parses a dedicated location field such as "Remote - Europe" or "Berlin, Germany (Hybrid)". */
export function parseLocation(
  text: string | null | undefined,
  aliases: readonly PlaceAlias[] = DEFAULT_ALIASES,
): JobLocation {
  const clean = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!clean) return { text: null, workMode: null, countries: [], regions: [] };
  return { text: clean, workMode: detectWorkMode(clean), ...findPlaces(clean, aliases) };
}

const PLACE_RUN = '([^.;\\n()\\[\\]]{2,70})';

/**
 * Phrases that state where a candidate must be. Only explicit wording is used: an office
 * address or "we have teams in ..." must not turn into a restriction.
 */
const RESTRICTION_PATTERNS: readonly RegExp[] = [
  // "US-only", "EU only", "United States only"
  /((?:(?:\p{Lu}\.){2,}|\p{Lu}\p{L}*)(?:[ /&,-]+(?:and |or )?(?:(?:\p{Lu}\.){2,}|\p{Lu}\p{L}*)){0,4})[ -]only\b/gu,
  // "must be based in the United States"
  new RegExp(
    `must\\s+(?:be\\s+)?(?:currently\\s+)?(?:based|located|resid(?:e|ing)|liv(?:e|ing))\\s+(?:in|within)\\s+(?:the\\s+)?${PLACE_RUN}`,
    'giu',
  ),
  // "authorized to work in the US", "eligible to work in Canada"
  new RegExp(
    `(?:authori[sz]ed|eligible|permitted|right)\\s+to\\s+work\\s+in\\s+(?:the\\s+)?${PLACE_RUN}`,
    'giu',
  ),
  // "open to candidates in Europe", "only for applicants based in the UK"
  new RegExp(
    `(?:candidates|applicants|residents)\\s+(?:who\\s+are\\s+)?(?:based|located|residing|living)?\\s*(?:in|within|from)\\s+(?:the\\s+)?${PLACE_RUN}`,
    'giu',
  ),
];

/** The same, for wording that also says the role is remote. */
const REMOTE_RESTRICTION_PATTERNS: readonly RegExp[] = [
  // "Remote (US)", "Remote [EMEA]"
  /remote\s*[([]\s*([^)\]\n]{2,70})[)\]]/giu,
  // "Remote - Europe", "Remote: EU", "Remote, EMEA"
  new RegExp(`remote\\s*[-–—:,]\\s*${PLACE_RUN}`, 'giu'),
  // "remote in the United States", "remote position within Europe", "remotely from EMEA"
  new RegExp(
    `remote(?:ly)?(?:\\s+(?:position|role|job|work|opportunity))?\\s+(?:in|within|from|across)\\s+(?:the\\s+)?${PLACE_RUN}`,
    'giu',
  ),
];

const WORLDWIDE =
  /work from anywhere|anywhere in the world|remote[- ]worldwide|worldwide[- ]remote|globally remote|fully remote,? worldwide/i;

export interface Restrictions extends PlaceMatches {
  /** True when the wording that named the places also said the role is remote. */
  remote: boolean;
}

/** Extracts explicit country or region restrictions from a title or description. */
export function scanRestrictions(
  text: string,
  aliases: readonly PlaceAlias[] = DEFAULT_ALIASES,
): Restrictions {
  const countries = new Set<string>();
  const regions = new Set<string>();
  let remote = false;

  const collect = (patterns: readonly RegExp[], impliesRemote: boolean): void => {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const places = findPlaces(match[1] ?? '', aliases);
        places.countries.forEach((country) => countries.add(country));
        places.regions.forEach((region) => regions.add(region));
        if (impliesRemote && places.countries.length + places.regions.length > 0) remote = true;
      }
    }
  };
  collect(RESTRICTION_PATTERNS, false);
  collect(REMOTE_RESTRICTION_PATTERNS, true);

  if (WORLDWIDE.test(text)) {
    regions.add('worldwide');
    remote = true;
  }

  return { countries: [...countries].sort(), regions: [...regions].sort(), remote };
}
