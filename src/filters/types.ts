/** Why a posting was dropped. Stored with the job and shown in /stats. */
export const DROP_REASONS = {
  too_old: 'Older than filters.max_age_days',
  title_not_included: 'Title has none of the wanted keywords',
  title_excluded: 'Title has an excluded keyword',
  seniority_excluded: 'Seniority level is excluded',
  seniority_not_included: 'Seniority level is not one of the wanted ones',
  seniority_unstated: 'Title states no seniority level',
  employment_not_allowed: 'Employment type is not allowed',
  stack_required_missing: 'None of the required technologies is mentioned',
  stack_primary_excluded: 'Main language or platform is excluded',
  blocked_signal: 'Contains an always-blocked keyword',
  location_always_blocked: 'Located in an always-blocked country',
  location_blocked_country: 'Located only in blocked countries',
  location_onsite: 'On-site or hybrid outside the allowed cities',
  location_restricted: 'Restricted to countries or regions that exclude yours',
  location_unstated: 'No location information',
  pay_below_floor: 'Pay is below the floor',
  pay_unstated: 'Pay is not stated',
  hours_pattern: 'Matches a working-hours drop pattern',
  hours_past_cutoff: 'Working hours start after your cutoff',
  hours_partial_overlap: 'Working hours run past your cutoff',
} as const;

/** Remarks on a kept posting. Shown on the card. */
export const FLAGS = {
  seniority_unstated: 'Seniority not stated',
  seniority_mixed: 'Title names both a wanted and an excluded level',
  stack_unknown: 'Too little text to check the stack',
  stack_primary_suspect: 'An excluded language features heavily',
  work_mode_unstated: 'Remote or on-site not stated',
  location_unstated: 'Location not stated',
  location_restricted: 'Location list may exclude your country',
  pay_unstated: 'Pay not stated',
  pay_currency_unknown: 'Pay currency has no rate in fx_rates',
  pay_period_unknown: 'Pay period not stated',
  pay_maybe_below_floor: 'Pay may be below the floor (period assumed)',
  hours_pattern: 'Mentions working-hours wording to check',
  hours_partial_overlap: 'Working hours run past your cutoff',
} as const;

export type DropReason = keyof typeof DROP_REASONS;
export type Flag = keyof typeof FLAGS;
export type Verdict = 'pass' | 'flag' | 'drop';

export type Outcome =
  | { kind: 'drop'; code: DropReason; detail?: string }
  | { kind: 'flag'; code: Flag; detail?: string };

export const drop = (code: DropReason, detail?: string): Outcome => ({
  kind: 'drop',
  code,
  detail,
});
export const flag = (code: Flag, detail?: string): Outcome => ({ kind: 'flag', code, detail });

export interface FilterResult {
  /** drop: at least one rule dropped it. flag: kept with remarks. pass: kept, nothing to add. */
  verdict: Verdict;
  /** In rule order; the first one is the primary reason. */
  dropReasons: DropReason[];
  flags: Flag[];
  /** Specifics per code, e.g. the matched keyword. */
  details: Partial<Record<DropReason | Flag, string>>;
}

export const describeReason = (code: string): string =>
  (DROP_REASONS as Record<string, string>)[code] ?? (FLAGS as Record<string, string>)[code] ?? code;
