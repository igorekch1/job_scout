import { describe, expect, it } from 'vitest';
import { formatSalary, parseSalary } from '../../src/normalize/salary.js';

const pick = (text: string, requireContext = false) => {
  const salary = parseSalary(text, { requireContext });
  return salary && [salary.min, salary.max, salary.currency, salary.period];
};

describe('parseSalary', () => {
  it.each([
    ['$120k - $150k', [120000, 150000, 'USD', 'year']],
    ['$120-150k per year', [120000, 150000, 'USD', 'year']],
    ['€5,000–7,000 / month', [5000, 7000, 'EUR', 'month']],
    ['5.000 - 7.000 EUR monthly', [5000, 7000, 'EUR', 'month']],
    ['USD 60-80/hr', [60, 80, 'USD', 'hour']],
    ['£70,000 per annum', [70000, 70000, 'GBP', 'year']],
    ['120 000 USD a year', [120000, 120000, 'USD', 'year']],
    ['$5k/mo', [5000, 5000, 'USD', 'month']],
    ['$45.50 per hour', [45.5, 45.5, 'USD', 'hour']],
    ['4000-6000 PLN', [4000, 6000, 'PLN', 'month']],
    ['CA$90,000 to CA$110,000 annually', [90000, 110000, 'CAD', 'year']],
    ['zł 18 000 – 24 000 monthly', [18000, 24000, 'PLN', 'month']],
  ])('reads %s', (text, expected) => {
    expect(pick(text)).toEqual(expected);
  });

  it('reads open-ended amounts', () => {
    expect(pick('Salary up to $8000 per month')).toEqual([null, 8000, 'USD', 'month']);
    expect(pick('from 4000 EUR monthly')).toEqual([4000, null, 'EUR', 'month']);
    expect(pick('$6000+ per month')).toEqual([6000, null, 'USD', 'month']);
  });

  it('marks a guessed period', () => {
    const salary = parseSalary('$130,000 - $160,000');
    expect(salary?.period).toBe('year');
    expect(salary?.periodInferred).toBe(true);
    expect(parseSalary('$130,000 per year')?.periodInferred).toBe(false);
  });

  it('ignores amounts without a currency', () => {
    expect(pick('5000-7000')).toBeNull();
    expect(pick('401k matching and 25 days off')).toBeNull();
    expect(pick('3-5 years of experience')).toBeNull();
  });

  it('ignores funding, revenue and head counts', () => {
    expect(pick('We raised $40M in Series B')).toBeNull();
    expect(pick('serving a $2 billion market')).toBeNull();
    expect(pick('backed by $15 million in funding')).toBeNull();
  });

  it('needs salary wording in free text when asked to', () => {
    expect(pick('Get a $500 voucher on your first day.', true)).toBeNull();
    expect(pick('The base salary range is $140,000 - $180,000.', true)).toEqual([
      140000,
      180000,
      'USD',
      'year',
    ]);
    expect(pick('We offer $50/hour for this contract.', true)).toEqual([50, 50, 'USD', 'hour']);
  });

  it('does not mistake perks, budgets and company figures for pay', () => {
    expect(pick('Benefits: €60/month Lifestyle allowance and a laptop.', true)).toBeNull();
    expect(pick('You will own a $300K monthly marketing budget.', true)).toBeNull();
    expect(pick('We offer a $1,500 - $2,000 home office stipend.', true)).toBeNull();
    expect(pick('€50 per month gym membership', true)).toBeNull();
    expect(pick('Salary: $5,000 per month + bonus', true)).toEqual([5000, 5000, 'USD', 'month']);
  });

  it('rejects amounts that cannot be pay for the stated period', () => {
    expect(pick('€60/month')).toBeNull();
    expect(pick('$2 per hour')).toBeNull();
    expect(pick('$900 per hour')).toBeNull();
    expect(pick('$1,200 per year')).toBeNull();
  });

  it('assumes a monthly figure for mid-sized amounts without a period', () => {
    expect(pick('$400–800')).toEqual([400, 800, 'USD', 'month']);
    expect(pick('$150')).toEqual([150, 150, 'USD', 'hour']);
  });

  it('keeps only the amount and its period as the source text', () => {
    expect(parseSalary('Rate: $25/hour\nEmployment: full-time')?.text).toBe('$25/hour');
    expect(parseSalary('$3,500/month for the first year')?.text).toBe('$3,500/month');
    expect(parseSalary('€5,000–7,000 / month')?.text).toBe('€5,000–7,000 / month');
  });

  it('prefers the pay range over other amounts in the same text', () => {
    const text =
      'Perks: $1,000 learning budget. Compensation: $95,000 - $120,000 per year plus equity.';
    expect(pick(text, true)).toEqual([95000, 120000, 'USD', 'year']);
  });

  it('returns null for empty input', () => {
    expect(parseSalary(null)).toBeNull();
    expect(parseSalary('')).toBeNull();
    expect(parseSalary('Competitive salary')).toBeNull();
  });
});

describe('formatSalary', () => {
  it('formats ranges, single values and open ends', () => {
    expect(formatSalary(parseSalary('$120k - $150k per year'))).toBe('$120k–150k / year');
    expect(formatSalary(parseSalary('4000-6000 PLN monthly'))).toBe('4,000–6,000 PLN / month');
    expect(formatSalary(parseSalary('up to €60/hr'))).toBe('up to €60 / hour');
    expect(formatSalary(parseSalary('$90,000'))).toBe('$90k / year (period assumed)');
    expect(formatSalary(null)).toBeNull();
  });
});
