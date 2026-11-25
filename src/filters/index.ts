import type { Config } from '../config/schema.js';
import type { Job } from '../normalize/job.js';
import { RULES } from './rules.js';
import type { DropReason, FilterResult, Flag } from './types.js';

export * from './types.js';

/**
 * Runs every rule and collects all outcomes, so the stored result shows each reason a
 * posting failed and not just the first.
 */
export function filterJob(job: Job, config: Config, now: Date = new Date()): FilterResult {
  const dropReasons: DropReason[] = [];
  const flags: Flag[] = [];
  const details: FilterResult['details'] = {};

  for (const rule of RULES) {
    for (const outcome of rule(job, { config, now })) {
      if (outcome.kind === 'drop') {
        if (!dropReasons.includes(outcome.code)) dropReasons.push(outcome.code);
      } else if (!flags.includes(outcome.code)) {
        flags.push(outcome.code);
      }
      if (outcome.detail && details[outcome.code] === undefined) {
        details[outcome.code] = outcome.detail;
      }
    }
  }

  const verdict = dropReasons.length > 0 ? 'drop' : flags.length > 0 ? 'flag' : 'pass';
  return { verdict, dropReasons, flags, details };
}

/** One line per active rule, for /filters and the README. */
export function describeFilters(config: Config): string[] {
  const { filters, user } = config;
  const lines: string[] = [];
  const list = (items: readonly (string | number)[]): string => items.join(', ');

  if (filters.max_age_days !== undefined) lines.push(`Max age: ${filters.max_age_days} days`);
  if (filters.title.include_any.length)
    lines.push(`Title must include: ${list(filters.title.include_any)}`);
  if (filters.title.exclude_any.length)
    lines.push(`Title must not include: ${list(filters.title.exclude_any)}`);
  if (filters.seniority.include_any.length)
    lines.push(`Seniority wanted: ${list(filters.seniority.include_any)}`);
  if (filters.seniority.exclude_any.length)
    lines.push(`Seniority dropped: ${list(filters.seniority.exclude_any)}`);
  if (filters.stack.required_any.length)
    lines.push(`Stack, any of: ${list(filters.stack.required_any)}`);
  if (filters.stack.exclude_primary.length)
    lines.push(`Not as main language: ${list(filters.stack.exclude_primary)}`);

  const disallowed = (['full_time', 'part_time', 'contract'] as const).filter(
    (type) => !filters.employment[type].allowed,
  );
  if (disallowed.length) lines.push(`Employment types dropped: ${list(disallowed)}`);

  const location = filters.location;
  lines.push(
    `Country: ${user.country}; restricted postings ${location.require_user_country_when_restricted ? 'dropped' : 'flagged'} unless they include it`,
  );
  if (location.allowed_regions.length)
    lines.push(`Regions accepted: ${list(location.allowed_regions)}`);
  if (location.allowed_countries.length)
    lines.push(`Extra countries accepted: ${list(location.allowed_countries)}`);
  if (location.blocked_countries.length)
    lines.push(`Countries blocked: ${list(location.blocked_countries)}`);
  lines.push(
    location.onsite_cities_allowed.length
      ? `On-site or hybrid only in: ${list(location.onsite_cities_allowed)}`
      : 'Remote only',
  );
  const blocked = location.always_blocked;
  if (blocked.countries.length || blocked.signals.length) {
    lines.push(`Always blocked: ${list([...blocked.countries, ...blocked.signals])}`);
  }

  const pay = filters.pay;
  if (pay.full_time_min_monthly !== undefined)
    lines.push(`Full-time floor: ${pay.full_time_min_monthly} ${pay.currency}/month`);
  if (pay.hourly_min !== undefined)
    lines.push(`Part-time and contract floor: ${pay.hourly_min} ${pay.currency}/hour`);
  lines.push(`Postings without pay: ${pay.keep_if_unstated ? 'kept and marked' : 'dropped'}`);

  const hours = filters.hours;
  if (hours.must_finish_by) lines.push(`Must finish by ${hours.must_finish_by} (${user.timezone})`);
  if (hours.drop_patterns.length) lines.push(`Hours drop patterns: ${hours.drop_patterns.length}`);
  if (hours.flag_patterns.length) lines.push(`Hours flag patterns: ${hours.flag_patterns.length}`);
  return lines;
}
