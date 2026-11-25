import { canonicalUrl } from '../dedup/canonical-url.js';
import { collapseWhitespace } from '../util/text.js';
import { buildAliases, type PlaceAlias } from './gazetteer.js';
import { htmlToText } from './html.js';
import type { EmploymentType, Job, RawJob, WorkMode } from './job.js';
import { detectWorkMode, parseLocation, scanRestrictions } from './location.js';
import { parseSalary } from './salary.js';

export interface NormalizeOptions {
  /** Place aliases; build once with `buildAliases(config.filters.location.extra_aliases)`. */
  aliases?: readonly PlaceAlias[];
}

const STRONG_REMOTE =
  /fully[- ]remote|100% remote|remote[- ]first|remote[- ]only|this (?:is a|role is|position is) (?:fully )?remote|work from home/i;

export function detectEmploymentType(title: string, description: string): EmploymentType | null {
  if (/\bintern(?:ship)?\b/i.test(title)) return 'internship';
  if (/\bpart[- ]time\b/i.test(title)) return 'part_time';
  if (/\b(?:contract(?:or)?|freelance|b2b)\b/i.test(title)) return 'contract';
  if (/\bfull[- ]time\b/i.test(title)) return 'full_time';

  const head = description.slice(0, 3000);
  if (/\bpart[- ]time\b/i.test(head) && !/\bfull[- ]time\b/i.test(head)) return 'part_time';
  if (/\b(?:contract (?:role|position|basis)|independent contractor|freelance (?:role|position|basis)|b2b contract)\b/i.test(head)) return 'contract'; // prettier-ignore
  if (/\bfull[- ]time\b/i.test(head)) return 'full_time';
  return null;
}

const defaultAliases = buildAliases();

/** Maps a source's raw posting to the common Job shape. Pure: no I/O, no clock. */
export function normalizeJob(
  raw: RawJob,
  source: { id: string; type: string },
  options: NormalizeOptions = {},
): Job {
  const aliases = options.aliases ?? defaultAliases;
  const title = collapseWhitespace(raw.title);
  const description = raw.descriptionText?.trim() || htmlToText(raw.descriptionHtml);
  const company = raw.company ? collapseWhitespace(raw.company) || null : null;

  const location = parseLocation(raw.locationText, aliases);
  let statedRemote = false;
  if (location.countries.length === 0 && location.regions.length === 0) {
    // the location line names no place: look for an explicit restriction in the text
    const stated = scanRestrictions(`${title}\n${description}`, aliases);
    location.countries = stated.countries;
    location.regions = stated.regions;
    statedRemote = stated.remote;
  }

  let workMode: WorkMode | null =
    raw.workMode ?? location.workMode ?? detectWorkMode(title) ?? (statedRemote ? 'remote' : null);
  if (!workMode && STRONG_REMOTE.test(description)) workMode = 'remote';
  location.workMode = workMode;

  const salary =
    raw.salary ??
    parseSalary(raw.salaryText) ??
    parseSalary(title) ??
    parseSalary(description, { requireContext: true });

  return {
    sourceType: source.type,
    sourceId: source.id,
    externalId: raw.externalId,
    url: raw.url,
    canonicalUrl: canonicalUrl(raw.url),
    company,
    title,
    description,
    location,
    remote: workMode === null ? null : workMode === 'remote',
    salary,
    employmentType: raw.employmentType ?? detectEmploymentType(title, description),
    postedAt: raw.postedAt ?? null,
    raw: raw.raw,
  };
}
