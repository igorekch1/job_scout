import { describe, expect, it } from 'vitest';
import { describeFilters, filterJob } from '../../src/filters/index.js';
import { hasKeyword } from '../../src/util/text.js';
import { makeJob, testConfig } from '../helpers.js';

const NOW = new Date('2026-03-10T12:00:00Z');
const LONG = `${'We build developer tools for logistics teams. '.repeat(6)}`;

const run = (
  job: Parameters<typeof makeJob>[0],
  filters: Record<string, unknown> = {},
  user = {},
) =>
  filterJob(
    makeJob(job),
    testConfig({
      user: { timezone: 'Europe/Amsterdam', country: 'NL', country_aliases: ['holland'], ...user },
      filters,
    }),
    NOW,
  );

describe('keyword matching', () => {
  it('matches whole words, including awkward ones', () => {
    expect(hasKeyword('Senior JavaScript Engineer', 'java')).toBe(false);
    expect(hasKeyword('Senior Java Engineer', 'java')).toBe(true);
    expect(hasKeyword('C++ and C# developer', 'c++')).toBe(true);
    expect(hasKeyword('C# developer', 'c++')).toBe(false);
    expect(hasKeyword('ASP.NET Core', '.net')).toBe(true);
    expect(hasKeyword('Node.js services', 'node.js')).toBe(true);
    expect(hasKeyword('full   stack engineer', 'full stack')).toBe(true);
    expect(hasKeyword('Sr. Engineer', 'sr.')).toBe(true);
    expect(hasKeyword('see jobs.example.ru/1', '.ru')).toBe(true);
  });
});

describe('with no rules configured', () => {
  it('keeps everything and only marks missing pay', () => {
    const result = run({});
    expect(result.verdict).toBe('flag');
    expect(result.dropReasons).toEqual([]);
    expect(result.flags).toEqual(['pay_unstated']);
  });
});

describe('age', () => {
  it('drops postings older than the limit and keeps undated ones', () => {
    const filters = { max_age_days: 3 };
    expect(run({ postedAt: new Date('2026-03-01T00:00:00Z') }, filters).dropReasons).toEqual([
      'too_old',
    ]);
    expect(run({ postedAt: new Date('2026-03-08T00:00:00Z') }, filters).dropReasons).toEqual([]);
    expect(run({ postedAt: null }, filters).dropReasons).toEqual([]);
  });
});

describe('title and seniority', () => {
  const filters = {
    title: { include_any: ['frontend', 'full stack'], exclude_any: ['qa'] },
    seniority: { include_any: ['senior', 'lead'], exclude_any: ['junior', 'staff'] },
  };

  it('applies include and exclude keywords', () => {
    expect(run({ title: 'Senior Frontend Engineer' }, filters).dropReasons).toEqual([]);
    expect(run({ title: 'Senior Backend Engineer' }, filters).dropReasons).toEqual([
      'title_not_included',
    ]);
    const qa = run({ title: 'Senior Frontend QA Engineer' }, filters);
    expect(qa.dropReasons).toEqual(['title_excluded']);
    expect(qa.details.title_excluded).toBe('qa');
  });

  it('drops excluded and unwanted levels', () => {
    expect(run({ title: 'Junior Frontend Engineer' }, filters).dropReasons).toEqual([
      'seniority_excluded',
    ]);
    expect(run({ title: 'Staff Frontend Engineer' }, filters).dropReasons).toEqual([
      'seniority_excluded',
    ]);
    expect(run({ title: 'Principal Frontend Engineer' }, filters).dropReasons).toEqual([
      'seniority_not_included',
    ]);
  });

  it('keeps a title that names both a wanted and an excluded level, with a remark', () => {
    const result = run({ title: 'Staff/Senior Frontend Engineer' }, filters);
    expect(result.dropReasons).toEqual([]);
    expect(result.flags).toContain('seniority_mixed');
    expect(result.details.seniority_mixed).toBe('senior, staff');
  });

  it('flags or drops titles without a level', () => {
    expect(run({ title: 'Frontend Engineer' }, filters).flags).toContain('seniority_unstated');
    const strict = { ...filters, seniority: { ...filters.seniority, keep_if_unstated: false } };
    expect(run({ title: 'Frontend Engineer' }, strict).dropReasons).toEqual(['seniority_unstated']);
  });
});

describe('employment', () => {
  it('drops disallowed types and keeps unstated ones', () => {
    const filters = { employment: { contract: { allowed: false } } };
    expect(run({ employmentType: 'contract' }, filters).dropReasons).toEqual([
      'employment_not_allowed',
    ]);
    expect(run({ employmentType: 'full_time' }, filters).dropReasons).toEqual([]);
    expect(run({ employmentType: null }, filters).dropReasons).toEqual([]);
  });
});

describe('stack', () => {
  const filters = {
    stack: { required_any: ['react', 'typescript'], exclude_primary: ['java', 'php'] },
  };

  it('requires one of the wanted technologies', () => {
    expect(
      run({ descriptionText: `${LONG} You will use React daily.` }, filters).dropReasons,
    ).toEqual([]);
    expect(
      run({ title: 'Senior Engineer', descriptionText: `${LONG} Vue and Svelte.` }, filters)
        .dropReasons,
    ).toEqual(['stack_required_missing']);
  });

  it('flags instead of dropping when there is too little text', () => {
    const result = run({ title: 'Senior Engineer', descriptionText: 'Apply now.' }, filters);
    expect(result.dropReasons).toEqual([]);
    expect(result.flags).toContain('stack_unknown');
  });

  it('drops an excluded main language named in the title', () => {
    const result = run(
      { title: 'Senior Java Engineer', descriptionText: `${LONG} Some React.` },
      filters,
    );
    expect(result.dropReasons).toEqual(['stack_primary_excluded']);
    expect(result.details.stack_primary_excluded).toBe('java');
  });

  it('flags a title that names both a wanted and an excluded technology', () => {
    const result = run({ title: 'Full Stack Engineer (React + Java)' }, filters);
    expect(result.dropReasons).toEqual([]);
    expect(result.flags).toContain('stack_primary_suspect');
  });

  it('flags a description that leans on an excluded language', () => {
    const heavy = `${LONG} Java services. Java 21. Deep Java knowledge. A little React.`;
    expect(run({ descriptionText: heavy }, filters).flags).toContain('stack_primary_suspect');
    const light = `${LONG} React, React Native and React Query. Java is a plus.`;
    expect(run({ descriptionText: light }, filters).flags).not.toContain('stack_primary_suspect');
  });
});

describe('stack: short language names', () => {
  it('counts only the capitalised form of one- and two-letter names', () => {
    const filters = { stack: { required_any: ['react'], exclude_primary: ['go'] } };
    const verbs = `${LONG} React. We go fast, go deep and go further. Go ahead and apply.`;
    expect(run({ descriptionText: verbs }, filters).flags).not.toContain('stack_primary_suspect');
    const language = `${LONG} React. Services in Go. Go 1.23. Strong Go skills. Go tooling.`;
    expect(run({ descriptionText: language }, filters).flags).toContain('stack_primary_suspect');
  });
});

describe('location', () => {
  it.each([
    ['Remote', []],
    ['Remote - Worldwide', []],
    ['Remote - Europe', []],
    ['Remote - European Union', []],
    ['Remote - EMEA', []],
    ['Remote - Netherlands', []],
    ['Remote (US, Netherlands)', []],
    ['Remote - Holland', []],
    ['Remote - United States', ['location_restricted']],
    ['Remote - US or Canada', ['location_restricted']],
    ['Remote - LATAM', ['location_restricted']],
    ['Berlin, Germany (Hybrid)', ['location_onsite']],
    ['London - On-site', ['location_onsite']],
  ])('"%s"', (locationText, expected) => {
    expect(run({ locationText }).dropReasons).toEqual(expected);
  });

  it('accepts extra regions and countries from config', () => {
    const filters = {
      location: { allowed_regions: ['North America', 'cet'], allowed_countries: ['GB'] },
    };
    expect(run({ locationText: 'Remote - US or Canada' }, filters).dropReasons).toEqual([
      'location_restricted',
    ]);
    expect(run({ locationText: 'Remote - North America' }, filters).dropReasons).toEqual([]);
    expect(run({ locationText: 'Remote (CET)' }, filters).dropReasons).toEqual([]);
    expect(run({ locationText: 'Remote - United Kingdom' }, filters).dropReasons).toEqual([]);
  });

  it('flags instead of dropping when the restriction rule is relaxed', () => {
    const result = run(
      { locationText: 'Remote - United States' },
      { location: { require_user_country_when_restricted: false } },
    );
    expect(result.dropReasons).toEqual([]);
    expect(result.flags).toContain('location_restricted');
    expect(result.details.location_restricted).toBe('US');
  });

  it('allows on-site work in listed cities only', () => {
    const filters = { location: { onsite_cities_allowed: ['Amsterdam'] } };
    expect(run({ locationText: 'Amsterdam (Hybrid)' }, filters).dropReasons).toEqual([]);
    expect(run({ locationText: 'Amsterdam' }, filters).dropReasons).toEqual([]);
    expect(run({ locationText: 'Rotterdam (Hybrid)' }, filters).dropReasons).toEqual([
      'location_onsite',
    ]);
  });

  it('handles postings that do not say remote or on-site', () => {
    const abroad = run({ locationText: 'Austin, Texas', descriptionText: LONG });
    expect(abroad.dropReasons).toEqual(['location_restricted']);
    const home = run({ locationText: 'Netherlands', descriptionText: LONG });
    expect(home.dropReasons).toEqual([]);
    expect(home.flags).toContain('work_mode_unstated');
  });

  it('flags or drops postings with no location at all', () => {
    const job = { locationText: null, descriptionText: LONG };
    expect(run(job).flags).toContain('location_unstated');
    expect(run(job, { location: { keep_if_unstated: false } }).dropReasons).toEqual([
      'location_unstated',
    ]);
  });

  it('reads a restriction from the description when the location line has none', () => {
    const job = {
      locationText: null,
      descriptionText: `${LONG} You must be authorized to work in the United States.`,
    };
    expect(run(job).dropReasons).toEqual(['location_restricted']);
  });

  it('applies blocked countries and hard blocks first', () => {
    const filters = {
      location: {
        blocked_countries: ['IN'],
        always_blocked: { countries: ['BR'], signals: ['casino', '.xyz'] },
      },
    };
    expect(run({ locationText: 'Remote - India' }, filters).dropReasons).toEqual([
      'location_blocked_country',
    ]);
    expect(run({ locationText: 'Remote - India, Netherlands' }, filters).dropReasons).toEqual([]);
    expect(run({ locationText: 'Remote - Brazil, Netherlands' }, filters).dropReasons).toEqual([
      'location_always_blocked',
    ]);
    const signal = run({ descriptionText: `${LONG} Join our online casino platform.` }, filters);
    expect(signal.dropReasons).toEqual(['blocked_signal']);
    expect(signal.details.blocked_signal).toBe('casino');
    expect(run({ url: 'https://jobs.example.xyz/1' }, filters).dropReasons).toEqual([
      'blocked_signal',
    ]);
  });
});

describe('pay', () => {
  const filters = {
    pay: {
      currency: 'USD',
      full_time_min_monthly: 5000,
      hourly_min: 30,
      fx_rates: { EUR: 1.1, GBP: 1.3 },
    },
  };

  it.each([
    ['$90,000 per year', null, []],
    ['$50,000 per year', null, ['pay_below_floor']],
    ['$40,000 - $70,000 per year', null, []],
    ['€4,000 per month', null, ['pay_below_floor']],
    ['€5,000 per month', null, []],
    ['$40 per hour', null, []],
    ['$20 per hour', null, ['pay_below_floor']],
    ['$35 per hour', 'contract', []],
    ['$25 per hour', 'contract', ['pay_below_floor']],
    ['$4,000 per month', 'part_time', ['pay_below_floor']],
    ['$6,000 per month', 'part_time', []],
  ] as const)('%s (%s)', (salaryText, employmentType, expected) => {
    expect(run({ salaryText, employmentType }, filters).dropReasons).toEqual(expected);
  });

  it('explains the comparison', () => {
    const result = run({ salaryText: '€4,000 per month' }, filters);
    expect(result.details.pay_below_floor).toBe('about 4,400 USD/month, floor 5,000');
  });

  it('keeps and marks postings without pay, or drops them when asked', () => {
    expect(run({}, filters).flags).toEqual(['pay_unstated']);
    const strict = { pay: { ...filters.pay, keep_if_unstated: false } };
    expect(run({}, strict).dropReasons).toEqual(['pay_unstated']);
  });

  it('flags what it cannot compare', () => {
    expect(run({ salaryText: '20 000 PLN monthly' }, filters).flags).toEqual([
      'pay_currency_unknown',
    ]);
    const guessed = run({ salaryText: '$3,000' }, filters);
    expect(guessed.dropReasons).toEqual([]);
    expect(guessed.flags).toEqual(['pay_maybe_below_floor']);
  });

  it('does nothing without floors', () => {
    expect(run({ salaryText: '$10 per hour' }).verdict).toBe('pass');
  });
});

describe('hours', () => {
  const filters = {
    hours: { must_finish_by: '19:00', drop_patterns: ['on[- ]?call'], flag_patterns: ['overlap'] },
  };
  const at = { postedAt: new Date('2026-01-15T12:00:00Z') };
  const text = (line: string) => ({ ...at, descriptionText: `${LONG} ${line}` });

  it('applies drop and flag patterns', () => {
    const dropped = run(text('Includes an On-Call rotation.'), filters);
    expect(dropped.dropReasons).toEqual(['hours_pattern']);
    expect(dropped.details.hours_pattern).toBe('On-Call');
    expect(run(text('Some overlap with the US team.'), filters).flags).toContain('hours_pattern');
  });

  it('compares stated hours with the cutoff in the user time zone', () => {
    expect(run(text('Core hours 9:00-17:00 CET.'), filters).dropReasons).toEqual([]);
    const partial = run(text('Working hours: 9am-5pm EST.'), filters);
    expect(partial.dropReasons).toEqual([]);
    expect(partial.flags).toContain('hours_partial_overlap');
    expect(partial.details.hours_partial_overlap).toBe('9am-5pm EST = 15:00-23:00 your time');
    expect(run(text('Working hours: 11am-7pm PST.'), filters).dropReasons).toEqual([
      'hours_past_cutoff',
    ]);
  });

  it('drops partial overlap when configured', () => {
    const strict = { hours: { ...filters.hours, drop_partial_overlap: true } };
    expect(run(text('Working hours: 9am-5pm EST.'), strict).dropReasons).toEqual([
      'hours_partial_overlap',
    ]);
  });
});

describe('combined', () => {
  it('reports every failed rule, primary reason first', () => {
    const result = run(
      {
        title: 'Junior QA Engineer',
        locationText: 'Remote - United States',
        salaryText: '$20 per hour',
      },
      {
        title: { exclude_any: ['qa'] },
        seniority: { exclude_any: ['junior'] },
        pay: { full_time_min_monthly: 5000 },
      },
    );
    expect(result.verdict).toBe('drop');
    expect(result.dropReasons).toEqual([
      'title_excluded',
      'seniority_excluded',
      'location_restricted',
      'pay_below_floor',
    ]);
  });

  it('describes the active rules', () => {
    const lines = describeFilters(
      testConfig({ filters: { max_age_days: 3, pay: { full_time_min_monthly: 3000 } } }),
    );
    expect(lines).toContain('Max age: 3 days');
    expect(lines).toContain('Full-time floor: 3000 USD/month');
    expect(lines).toContain('Remote only');
  });
});
