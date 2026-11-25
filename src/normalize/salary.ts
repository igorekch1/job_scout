import type { Salary, SalaryPeriod } from './job.js';

const SYMBOLS: Readonly<Record<string, string>> = {
  US$: 'USD',
  $: 'USD',
  CA$: 'CAD',
  C$: 'CAD',
  A$: 'AUD',
  AU$: 'AUD',
  '€': 'EUR',
  '£': 'GBP',
  '₴': 'UAH',
  '₹': 'INR',
  '¥': 'JPY',
  zł: 'PLN',
};

const CODES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'PLN', 'UAH', 'SEK', 'NOK', 'DKK', 'CZK',
  'HUF', 'RON', 'BGN', 'INR', 'JPY', 'SGD', 'HKD', 'BRL', 'MXN', 'ILS', 'AED', 'ZAR', 'TRY',
]; // prettier-ignore

const CURRENCY = `(?:US\\$|CA\\$|AU\\$|C\\$|A\\$|\\$|€|£|₴|₹|¥|zł|${CODES.join('|')})`;
const NUMBER = '\\d{1,3}(?:[,.\\u00a0\\u202f ]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
const AMOUNT = `(${CURRENCY})?\\s?(${NUMBER})\\s?([kK])?\\s?(${CURRENCY})?`;
const RANGE = new RegExp(`${AMOUNT}(?:\\s?(?:-|–|—|to)\\s?${AMOUNT})?`, 'gu');

const PERIODS: readonly (readonly [SalaryPeriod, RegExp])[] = [
  ['hour', /^\s*(?:\/|per|an|a|p\/)?\s*(?:h\b|hr\b|hrs\b|hour\b|hourly\b)/i],
  ['day', /^\s*(?:\/|per|a)?\s*(?:day\b|daily\b)/i],
  ['week', /^\s*(?:\/|per|a)?\s*(?:wk\b|week\b|weekly\b)/i],
  ['month', /^\s*(?:\/|per|a)?\s*(?:mo\b|mth\b|month\b|monthly\b|p\.?m\.?(?![a-z]))/i],
  [
    'year',
    /^\s*(?:\/|per|a)?\s*(?:y\b|yr\b|year\b|yearly\b|annum\b|annual(?:ly)?\b|p\.?a\.?(?![a-z]))/i,
  ],
];

const PERIOD_ANYWHERE: readonly (readonly [SalaryPeriod, RegExp])[] = [
  ['hour', /\b(?:per hour|hourly|an hour|\/\s?h(?:ou)?r?)\b/i],
  ['day', /\b(?:per day|daily rate|day rate)\b/i],
  ['month', /\b(?:per month|monthly|a month|\/\s?mo(?:nth)?)\b/i],
  ['year', /\b(?:per year|yearly|annual(?:ly)?|per annum|a year|\/\s?y(?:ea)?r)\b/i],
];

const CONTEXT =
  /salary|compensation|\bpay\b|\bpaid\b|\brate\b|\bbase\b|\bOTE\b|remuneration|wage|budget|\bearn/i;
const NOT_PAY_AFTER =
  /^\s?(?:m\b|mm\b|mn\b|million|billion|bn\b|b\b|%|x\b|\+?\s*(?:users|customers|employees|people|in (?:funding|revenue|arr)))/i;
const NOT_PAY_BEFORE =
  /(?:raised|funding|series [a-e]|valuation|revenue|arr of|worth)\s*(?:of\s*)?$/i;

function toCurrency(token: string | undefined): string | null {
  if (!token) return null;
  return SYMBOLS[token] ?? token.toUpperCase();
}

function toNumber(token: string, kilo: boolean): number {
  let text = token.replace(/[\u00a0\u202f ]/g, '');
  if (/^\d{1,3}(?:[.,]\d{3})+(?:\.\d{1,2})?$/.test(text)) {
    // thousands separators, optionally followed by a decimal part
    const decimal = /\.\d{1,2}$/.exec(text)?.[0] ?? '';
    const whole = decimal ? text.slice(0, -decimal.length) : text;
    text = whole.replace(/[.,]/g, '') + decimal;
  } else {
    text = text.replace(',', '.');
  }
  const value = Number(text);
  return kilo ? value * 1000 : value;
}

function inferPeriod(amount: number): SalaryPeriod | null {
  if (amount >= 20_000) return 'year';
  if (amount >= 1_000) return 'month';
  if (amount > 0 && amount < 300) return 'hour';
  return null;
}

interface Candidate {
  salary: Salary;
  score: number;
}

export interface ParseSalaryOptions {
  /**
   * Require salary wording near the amount. Use it for free text such as a description;
   * leave it off for a dedicated salary field or a title.
   */
  requireContext?: boolean;
}

/**
 * Reads a pay figure such as "$120k - $150k", "€5,000–7,000 / month", "USD 60-80/hr" or
 * "up to £70,000 per annum". An amount without a currency is never treated as pay.
 */
export function parseSalary(
  text: string | null | undefined,
  options: ParseSalaryOptions = {},
): Salary | null {
  if (!text) return null;
  const candidates: Candidate[] = [];

  for (const match of text.matchAll(RANGE)) {
    const [whole, cur1a, num1, k1, cur1b, cur2a, num2, k2, cur2b] = match;
    if (!num1) continue;
    const currency = toCurrency(cur1a ?? cur1b ?? cur2a ?? cur2b);
    if (!currency) continue;

    const start = match.index;
    const before = text.slice(Math.max(0, start - 60), start);
    const after = text.slice(start + whole.length, start + whole.length + 40);
    if (NOT_PAY_AFTER.test(after) || NOT_PAY_BEFORE.test(before)) continue;

    const isRange = num2 !== undefined;
    // "$120-150k": the multiplier belongs to both sides
    const firstKilo = Boolean(k1) || (isRange && Boolean(k2) && toNumber(num1, false) < 1000);
    const first = toNumber(num1, firstKilo);
    const second = isRange ? toNumber(num2, Boolean(k2)) : null;
    if (!Number.isFinite(first) || first < 5) continue;
    if (second !== null && (!Number.isFinite(second) || second < first)) continue;

    let period = PERIODS.find(([, regex]) => regex.test(after))?.[0] ?? null;
    const explicitPeriod = period !== null;
    if (!period) {
      const nearby = `${before.slice(-40)} ${after}`;
      period = PERIOD_ANYWHERE.find(([, regex]) => regex.test(nearby))?.[0] ?? null;
    }
    const stated = period !== null;
    period ??= inferPeriod(second ?? first);

    let min: number | null = first;
    let max: number | null = second ?? first;
    if (!isRange) {
      if (/(?:up to|upto|max(?:imum)?(?: of)?|до)\s*$/i.test(before)) min = null;
      else if (/(?:from|starting (?:at|from)|min(?:imum)?(?: of)?|at least|від|от)\s*$/i.test(before) || /^\s?\+/.test(after)) max = null; // prettier-ignore
    }

    const hasContext = CONTEXT.test(before) || CONTEXT.test(after.slice(0, 20));
    if (options.requireContext && !hasContext && !explicitPeriod && !(isRange && first >= 1000)) {
      continue;
    }

    candidates.push({
      salary: {
        min,
        max,
        currency,
        period,
        periodInferred: !stated && period !== null,
        text: whole.trim() + (explicitPeriod ? (after.match(/^\s*\S+(?:\s\S+)?/)?.[0] ?? '') : ''),
      },
      score: (isRange ? 2 : 0) + (stated ? 2 : 0) + (hasContext ? 1 : 0),
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.salary;
}

const SYMBOL_BY_CODE: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£' };
const PERIOD_LABEL: Readonly<Record<SalaryPeriod, string>> = {
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

function formatAmount(value: number): string {
  if (value >= 10_000 && value % 1000 === 0) return `${value / 1000}k`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Human-readable form for cards and tracker rows, e.g. "$120k–150k / year". */
export function formatSalary(salary: Salary | null): string | null {
  if (!salary || (salary.min === null && salary.max === null)) return null;
  const symbol = salary.currency ? SYMBOL_BY_CODE[salary.currency] : undefined;
  const prefix = symbol ?? '';
  const suffix = symbol || !salary.currency ? '' : ` ${salary.currency}`;
  let body: string;
  if (salary.min !== null && salary.max !== null) {
    body =
      salary.min === salary.max
        ? `${prefix}${formatAmount(salary.min)}`
        : `${prefix}${formatAmount(salary.min)}–${formatAmount(salary.max)}`;
  } else if (salary.max !== null) {
    body = `up to ${prefix}${formatAmount(salary.max)}`;
  } else {
    body = `from ${prefix}${formatAmount(salary.min!)}`;
  }
  const period = salary.period ? ` / ${PERIOD_LABEL[salary.period]}` : '';
  return `${body}${suffix}${period}${salary.periodInferred ? ' (period assumed)' : ''}`;
}
