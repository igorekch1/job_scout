import type { Config } from '../config/schema.js';
import { regionContains, resolveRegion } from '../normalize/gazetteer.js';
import {
  fitHours,
  formatMinutes,
  parseHoursRanges,
  toLocalHours,
  zoneOffsetMinutes,
} from '../normalize/hours.js';
import type { Job, SalaryPeriod } from '../normalize/job.js';
import { countKeyword, findKeyword, hasKeyword, keywordRegex } from '../util/text.js';
import { drop, flag, type Outcome } from './types.js';

export interface RuleContext {
  config: Config;
  now: Date;
}

export type Rule = (job: Job, context: RuleContext) => Outcome[];

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------- age */

export const ageRule: Rule = (job, { config, now }) => {
  const maxDays = config.filters.max_age_days;
  if (maxDays === undefined || !job.postedAt) return [];
  const ageDays = (now.getTime() - job.postedAt.getTime()) / DAY_MS;
  return ageDays > maxDays ? [drop('too_old', `${Math.floor(ageDays)} days old`)] : [];
};

/* -------------------------------------------------------------------- title */

export const titleRule: Rule = (job, { config }) => {
  const { include_any: include, exclude_any: exclude } = config.filters.title;
  const excluded = findKeyword(job.title, exclude);
  if (excluded) return [drop('title_excluded', excluded)];
  if (include.length > 0 && !findKeyword(job.title, include)) return [drop('title_not_included')];
  return [];
};

/* ---------------------------------------------------------------- seniority */

const SENIORITY_WORDS = [
  'intern', 'internship', 'trainee', 'junior', 'jr', 'entry level', 'entry-level', 'graduate',
  'mid', 'middle', 'mid-level', 'intermediate', 'senior', 'sr', 'lead', 'staff', 'principal',
  'architect', 'head of', 'director', 'vp', 'manager', 'chief',
]; // prettier-ignore

export const seniorityRule: Rule = (job, { config }) => {
  const rules = config.filters.seniority;
  const excluded = findKeyword(job.title, rules.exclude_any);
  const included = findKeyword(job.title, rules.include_any);
  if (excluded) {
    // "Middle/Senior Engineer" is open to the wanted level too: keep it, with a remark
    return [
      included
        ? flag('seniority_mixed', `${included}, ${excluded}`)
        : drop('seniority_excluded', excluded),
    ];
  }
  if (rules.include_any.length === 0 || included) return [];

  const stated = findKeyword(job.title, SENIORITY_WORDS);
  if (stated) return [drop('seniority_not_included', stated)];
  return rules.keep_if_unstated ? [flag('seniority_unstated')] : [drop('seniority_unstated')];
};

/* --------------------------------------------------------------- employment */

export const employmentRule: Rule = (job, { config }) => {
  const type = job.employmentType;
  if (type !== 'full_time' && type !== 'part_time' && type !== 'contract') return [];
  return config.filters.employment[type].allowed ? [] : [drop('employment_not_allowed', type)];
};

/* -------------------------------------------------------------------- stack */

/** Below this much text a missing keyword proves nothing. */
const MIN_TEXT_FOR_STACK_CHECK = 200;
/** How often an excluded language must appear before it is suspected to be the main one. */
const PRIMARY_MENTIONS = 3;

/**
 * Mentions of a technology in running text. One- and two-letter names ("go", "r") are ordinary
 * words in lowercase, so only their capitalised form counts.
 */
function countMentions(text: string, keyword: string): number {
  if (keyword.length > 2) return countKeyword(text, keyword);
  const capitalised = keyword.charAt(0).toUpperCase() + keyword.slice(1);
  return text.match(keywordRegex(capitalised, 'gu'))?.length ?? 0;
}

export const stackRule: Rule = (job, { config }) => {
  const { required_any: required, exclude_primary: excluded } = config.filters.stack;
  const text = `${job.title}\n${job.description}`;
  const outcomes: Outcome[] = [];

  const excludedInTitle = findKeyword(job.title, excluded);
  if (excludedInTitle) {
    outcomes.push(
      findKeyword(job.title, required)
        ? flag('stack_primary_suspect', excludedInTitle)
        : drop('stack_primary_excluded', excludedInTitle),
    );
  } else if (excluded.length > 0) {
    const wanted = Math.max(0, ...required.map((keyword) => countKeyword(text, keyword)));
    const heavy = excluded
      .map((keyword) => ({ keyword, count: countMentions(job.description, keyword) }))
      .filter(({ count }) => count >= PRIMARY_MENTIONS && count > wanted)
      .sort((a, b) => b.count - a.count)[0];
    if (heavy) outcomes.push(flag('stack_primary_suspect', heavy.keyword));
  }

  if (required.length > 0 && !findKeyword(text, required)) {
    outcomes.push(
      job.description.length < MIN_TEXT_FOR_STACK_CHECK
        ? flag('stack_unknown')
        : drop('stack_required_missing'),
    );
  }
  return outcomes;
};

/* ----------------------------------------------------------------- location */

export const locationRule: Rule = (job, { config }) => {
  const rules = config.filters.location;
  const { country, country_aliases: aliases } = config.user;
  const location = job.location;

  const haystack = [
    job.title,
    job.company ?? '',
    location.text ?? '',
    job.description,
    job.url,
  ].join('\n');
  const signal = findKeyword(haystack, rules.always_blocked.signals);
  if (signal) return [drop('blocked_signal', signal)];

  const blockedAlways = location.countries.find((code) =>
    rules.always_blocked.countries.includes(code),
  );
  if (blockedAlways) return [drop('location_always_blocked', blockedAlways)];

  if (
    location.countries.length > 0 &&
    location.countries.every((code) => rules.blocked_countries.includes(code))
  ) {
    return [drop('location_blocked_country', location.countries.join(', '))];
  }

  const cityAllowed =
    location.text !== null && findKeyword(location.text, rules.onsite_cities_allowed) !== undefined;

  if (location.workMode === 'onsite' || location.workMode === 'hybrid') {
    return cityAllowed ? [] : [drop('location_onsite', location.text ?? location.workMode)];
  }

  const hasPlaces = location.countries.length > 0 || location.regions.length > 0;
  const outcomes: Outcome[] = [];

  if (location.workMode === null) {
    if (cityAllowed) return [];
    if (!hasPlaces) {
      return [rules.keep_if_unstated ? flag('location_unstated') : drop('location_unstated')];
    }
    outcomes.push(flag('work_mode_unstated'));
  }
  if (!hasPlaces) return outcomes;

  const allowedRegions = new Set(
    rules.allowed_regions.map((name) => resolveRegion(name) ?? name.toLowerCase()),
  );
  const accepted =
    location.countries.includes(country) ||
    location.countries.some((code) => rules.allowed_countries.includes(code)) ||
    location.regions.some(
      (region) => regionContains(region, country) || allowedRegions.has(region),
    ) ||
    (location.text !== null && aliases.some((alias) => hasKeyword(location.text!, alias)));

  if (!accepted) {
    const stated = [...location.regions, ...location.countries].join(', ');
    outcomes.push(
      rules.require_user_country_when_restricted
        ? drop('location_restricted', stated)
        : flag('location_restricted', stated),
    );
  }
  return outcomes;
};

/* ---------------------------------------------------------------------- pay */

const DAYS_PER_MONTH = 21;
const WEEKS_PER_MONTH = 52 / 12;

function toMonthly(amount: number, period: SalaryPeriod, hoursPerMonth: number): number {
  switch (period) {
    case 'hour':
      return amount * hoursPerMonth;
    case 'day':
      return amount * DAYS_PER_MONTH;
    case 'week':
      return amount * WEEKS_PER_MONTH;
    case 'month':
      return amount;
    case 'year':
      return amount / 12;
  }
}

const money = (value: number): string => Math.round(value).toLocaleString('en-US');

export const payRule: Rule = (job, { config }) => {
  const rules = config.filters.pay;
  const salary = job.salary;
  const top = salary ? (salary.max ?? salary.min) : null;
  if (!salary || top === null) {
    return [rules.keep_if_unstated ? flag('pay_unstated') : drop('pay_unstated')];
  }

  const hourly = job.employmentType === 'part_time' || job.employmentType === 'contract';
  const floor = hourly ? rules.hourly_min : rules.full_time_min_monthly;
  if (floor === undefined) return [];

  const rate = salary.currency === rules.currency ? 1 : rules.fx_rates[salary.currency ?? ''];
  if (rate === undefined) return [flag('pay_currency_unknown', salary.currency ?? 'unknown')];
  if (!salary.period) return [flag('pay_period_unknown')];

  const monthly = toMonthly(top * rate, salary.period, rules.hours_per_month);
  const value = hourly ? monthly / rules.hours_per_month : monthly;
  if (value >= floor) return [];

  const unit = hourly ? 'hour' : 'month';
  const detail = `about ${money(value)} ${rules.currency}/${unit}, floor ${money(floor)}`;
  // a guessed period must not cost the user a good posting
  return [
    salary.periodInferred ? flag('pay_maybe_below_floor', detail) : drop('pay_below_floor', detail),
  ];
};

/* -------------------------------------------------------------------- hours */

const regexCache = new Map<string, RegExp>();
const compile = (source: string): RegExp => {
  let regex = regexCache.get(source);
  if (!regex) {
    regex = new RegExp(source, 'iu');
    regexCache.set(source, regex);
  }
  return regex;
};

const firstMatch = (text: string, patterns: readonly string[]): string | undefined => {
  for (const source of patterns) {
    const match = compile(source).exec(text);
    if (match) return match[0];
  }
  return undefined;
};

export const hoursRule: Rule = (job, { config, now }) => {
  const rules = config.filters.hours;
  const text = `${job.title}\n${job.description}`;

  const dropped = firstMatch(text, rules.drop_patterns);
  if (dropped) return [drop('hours_pattern', dropped)];

  const outcomes: Outcome[] = [];
  const flagged = firstMatch(text, rules.flag_patterns);
  if (flagged) outcomes.push(flag('hours_pattern', flagged));

  if (rules.must_finish_by) {
    const at = job.postedAt ?? now;
    const userOffset = zoneOffsetMinutes(config.user.timezone, at);
    for (const range of parseHoursRanges(text, at)) {
      const fit = fitHours(range, userOffset, rules.must_finish_by);
      if (fit === 'ok') continue;
      const local = toLocalHours(range, userOffset);
      const detail = `${range.text} = ${formatMinutes(local.start)}-${formatMinutes(local.end)} your time`;
      if (fit === 'past') return [drop('hours_past_cutoff', detail)];
      outcomes.push(
        rules.drop_partial_overlap
          ? drop('hours_partial_overlap', detail)
          : flag('hours_partial_overlap', detail),
      );
      break;
    }
  }
  return outcomes;
};

/** Rule order decides the primary drop reason. */
export const RULES: readonly Rule[] = [
  ageRule,
  titleRule,
  seniorityRule,
  employmentRule,
  stackRule,
  locationRule,
  payRule,
  hoursRule,
];
