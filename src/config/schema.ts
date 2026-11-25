import { z } from 'zod';

/* ------------------------------------------------------------------ helpers */

const isValidRegex = (source: string): boolean => {
  try {
    new RegExp(source, 'iu');
    return true;
  } catch {
    return false;
  }
};

const isValidTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const keywordList = (description: string) =>
  z.array(z.string().trim().min(1)).default([]).describe(description);

const regexList = (description: string) =>
  z
    .array(z.string().min(1).refine(isValidRegex, 'invalid regular expression'))
    .default([])
    .describe(description);

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected a 24-hour time such as "19:00"');

const countryCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'expected an ISO 3166-1 alpha-2 code such as "NL"')
  .transform((value) => value.toUpperCase());

const slug = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'use letters, digits, ".", "_" and "-" only');

const intervalMinutes = z
  .number()
  .int()
  .min(1)
  .max(24 * 60)
  .optional()
  .describe('Polling interval for this source. Falls back to schedule.default_interval_minutes.');

const enabled = (byDefault: boolean) =>
  z.boolean().default(byDefault).describe('Turn this source on or off.');

/* --------------------------------------------------------------------- user */

const userSchema = z
  .strictObject({
    timezone: z
      .string()
      .refine(isValidTimeZone, 'unknown IANA time zone')
      .describe('Your IANA time zone, for example "Europe/Amsterdam".'),
    country: countryCode.describe('Your country as an ISO 3166-1 alpha-2 code.'),
    country_aliases: keywordList(
      'Extra spellings of your country to recognise in postings (other languages, abbreviations).',
    ),
  })
  .describe('Who the bot is searching for.');

/* ---------------------------------------------------------------------- app */

const appSchema = z
  .strictObject({
    log_level: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info')
      .describe('Log verbosity. The LOG_LEVEL environment variable overrides it.'),
    user_agent_contact: z
      .string()
      .trim()
      .default('')
      .describe(
        'Optional URL or email appended to the User-Agent so site owners can reach you. Empty sends "job-scout/<version>" only.',
      ),
  })
  .describe('Process-wide settings.');

/* ----------------------------------------------------------------- schedule */

const scheduleSchema = z
  .strictObject({
    default_interval_minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(15)
      .describe('How often each source is polled unless it sets its own interval.'),
    max_concurrent_sources: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3)
      .describe('How many sources may be fetched at the same time.'),
  })
  .describe('Collector scheduling.');

/* ------------------------------------------------------------------ sources */

const rssFeedSchema = z.strictObject({
  id: slug.describe('Unique name for this feed, shown in /status and on cards.'),
  url: z.url({ protocol: /^https?$/ }).describe('RSS or Atom feed URL.'),
  title_pattern: z
    .string()
    .refine(isValidRegex, 'invalid regular expression')
    .optional()
    .describe(
      'Optional regex applied to the item title, for feeds that pack several fields into it. Named groups "title", "company", "location" and "salary" are used when present, e.g. "^(?<title>.+) at (?<company>.+)$".',
    ),
  defaults: z
    .strictObject({
      company: z.string().trim().min(1).optional().describe('Company name when the feed has none.'),
      remote: z
        .boolean()
        .optional()
        .describe(
          'true: every item is remote. false: an item is on-site unless its text says remote. Omit when the feed mixes both without saying.',
        ),
      employment_type: z
        .enum(['full_time', 'part_time', 'contract'])
        .optional()
        .describe('Employment type when the feed does not state it.'),
    })
    .prefault({})
    .describe('Values assumed for every item of the feed when the feed does not carry them.'),
});

const rssSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    feeds: z.array(rssFeedSchema).default([]).describe('Feeds to poll.'),
  })
  .describe('Generic RSS/Atom source for job boards that publish feeds for saved searches.');

const greenhouseSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    boards: z
      .array(slug)
      .default([])
      .describe('Greenhouse board slugs to watch (the part after /boards/ in the board URL).'),
  })
  .describe('Greenhouse public job board API.');

const ashbySchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    boards: z
      .array(slug)
      .default([])
      .describe('Ashby job board names to watch (the part after jobs.ashbyhq.com/).'),
  })
  .describe('Ashby public job posting API.');

const leverSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    companies: z.array(slug).default([]).describe('Lever company slugs to watch.'),
  })
  .describe('Lever public postings API. Not implemented yet.');

const himalayasSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    queries: keywordList('Search queries.'),
  })
  .describe('Himalayas public remote-jobs API. Not implemented yet.');

const remotiveSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    category: z.string().trim().min(1).optional().describe('Remotive category slug.'),
    search: keywordList('Search terms.'),
  })
  .describe('Remotive public remote-jobs API. Not implemented yet.');

const taggedApi = (name: string) =>
  z
    .strictObject({
      enabled: enabled(false),
      interval_minutes: intervalMinutes,
      tags: keywordList('Tags to query.'),
    })
    .describe(`${name} public remote-jobs API. Not implemented yet.`);

const telegramChannelsSchema = z
  .strictObject({
    enabled: enabled(false),
    interval_minutes: intervalMinutes,
    channels: keywordList('Public channel usernames to read, without the leading "@".'),
  })
  .describe(
    'Reads posts from Telegram channels through YOUR OWN account (TG_API_ID, TG_API_HASH, TG_SESSION). Disabled by default. Not implemented yet.',
  );

const sourcesSchema = z
  .strictObject({
    rss: rssSchema.prefault({}),
    greenhouse: greenhouseSchema.prefault({}),
    ashby: ashbySchema.prefault({}),
    lever: leverSchema.prefault({}),
    himalayas: himalayasSchema.prefault({}),
    remotive: remotiveSchema.prefault({}),
    remoteok: taggedApi('RemoteOK').prefault({}),
    jobicy: taggedApi('Jobicy').prefault({}),
    telegram_channels: telegramChannelsSchema.prefault({}),
  })
  .describe('Where jobs come from. Every source is optional and off by default.');

/* -------------------------------------------------------------------- dedup */

const dedupSchema = z
  .strictObject({
    window_days: z
      .number()
      .int()
      .min(1)
      .max(180)
      .default(14)
      .describe(
        'Two postings with the same company and title are the same job when seen within this many days.',
      ),
    primary_source_priority: z
      .array(z.string().trim().min(1))
      .default(['greenhouse', 'ashby', 'lever', 'rss'])
      .describe(
        'Source types ordered by which link becomes the primary one. Employer ATS links come first by default.',
      ),
  })
  .describe('How duplicates across sources are merged.');

/* ------------------------------------------------------------------ filters */

const employmentRule = z.strictObject({
  allowed: z.boolean().default(true).describe('Keep postings of this employment type.'),
});

const filtersSchema = z
  .strictObject({
    max_age_days: z
      .number()
      .min(0)
      .max(365)
      .optional()
      .describe('Drop postings published more than this many days ago. Omit to keep any age.'),
    title: z
      .strictObject({
        include_any: keywordList(
          'Keep only titles containing at least one of these. Empty keeps all.',
        ),
        exclude_any: keywordList('Drop titles containing any of these.'),
      })
      .prefault({})
      .describe('Title keyword rules. Matching is case-insensitive on whole words.'),
    seniority: z
      .strictObject({
        include_any: keywordList('Seniority words you want, e.g. senior, lead. Empty keeps all.'),
        exclude_any: keywordList('Seniority words to drop, e.g. junior, staff.'),
        keep_if_unstated: z
          .boolean()
          .default(true)
          .describe('Keep titles that state no seniority at all (marked on the card).'),
      })
      .prefault({})
      .describe('Seniority rules, matched against the title.'),
    stack: z
      .strictObject({
        required_any: keywordList(
          'The title or description must mention at least one of these. Empty keeps all.',
        ),
        exclude_primary: keywordList(
          'Languages or platforms you do not want as the main one. Dropped when named in the title; flagged when the description leans on them.',
        ),
      })
      .prefault({})
      .describe('Technology rules.'),
    employment: z
      .strictObject({
        full_time: employmentRule.prefault({}),
        part_time: employmentRule.prefault({}),
        contract: employmentRule.prefault({}),
      })
      .prefault({})
      .describe('Which employment types to keep. Postings that do not state a type are kept.'),
    location: z
      .strictObject({
        allowed_regions: keywordList(
          'Regions you accept for remote roles, e.g. worldwide, europe, emea. Regions that contain your country are always accepted.',
        ),
        allowed_countries: z
          .array(countryCode)
          .default([])
          .describe('Extra countries you accept besides your own (ISO codes).'),
        blocked_countries: z
          .array(countryCode)
          .default([])
          .describe('Drop postings whose stated countries are all in this list.'),
        require_user_country_when_restricted: z
          .boolean()
          .default(true)
          .describe(
            'Drop postings restricted to a list of countries or regions that does not include yours. When false they are kept and flagged.',
          ),
        onsite_cities_allowed: keywordList(
          'Cities where on-site or hybrid work is acceptable. Empty means remote only.',
        ),
        always_blocked: z
          .strictObject({
            countries: z
              .array(countryCode)
              .default([])
              .describe('Drop any posting that names one of these countries as a location.'),
            signals: keywordList(
              'Drop any posting whose title, company, description or URL contains one of these keywords or domains.',
            ),
          })
          .prefault({})
          .describe('Hard blocks that win over every other location rule.'),
        keep_if_unstated: z
          .boolean()
          .default(true)
          .describe('Keep postings with no usable location information (marked on the card).'),
        remote_keywords: keywordList(
          'Extra words that mean "remote" in the language of your sources. English wording is built in.',
        ),
        extra_aliases: z
          .record(z.string(), z.string().trim().min(1))
          .default({})
          .describe(
            'Extra place names mapped to an ISO country code or a region id, e.g. { "benelux": "europe" }.',
          ),
      })
      .prefault({})
      .describe('Location rules.'),
    pay: z
      .strictObject({
        currency: z
          .string()
          .trim()
          .regex(/^[A-Za-z]{3}$/, 'expected a 3-letter currency code such as "USD"')
          .transform((value) => value.toUpperCase())
          .default('USD')
          .describe('Currency of the floors below.'),
        full_time_min_monthly: z
          .number()
          .min(0)
          .optional()
          .describe('Monthly floor for full-time roles. Omit for no floor.'),
        hourly_min: z
          .number()
          .min(0)
          .optional()
          .describe('Hourly floor for part-time and contract roles. Omit for no floor.'),
        hours_per_month: z
          .number()
          .min(1)
          .max(744)
          .default(160)
          .describe('Used to convert between hourly and monthly pay.'),
        keep_if_unstated: z
          .boolean()
          .default(true)
          .describe('Keep postings that state no pay (marked "pay not stated").'),
        fx_rates: z
          .record(
            z.string().regex(/^[A-Za-z]{3}$/, 'expected a 3-letter currency code'),
            z.number().positive(),
          )
          .default({})
          .describe(
            'Static conversion table: value of 1 unit of each currency in `currency`. Postings in a currency missing here are kept and flagged.',
          ),
      })
      .prefault({})
      .describe(
        'Pay floors. A posting is dropped only when the top of its stated range is below the floor.',
      ),
    hours: z
      .strictObject({
        must_finish_by: timeOfDay
          .optional()
          .describe('Latest local time you are willing to work until, in user.timezone.'),
        drop_partial_overlap: z
          .boolean()
          .default(false)
          .describe(
            'What to do with stated working hours that start before must_finish_by but end after it: drop (true) or keep and flag (false).',
          ),
        drop_patterns: regexList(
          'Regular expressions (case-insensitive) that drop a posting when found in its text.',
        ),
        flag_patterns: regexList(
          'Regular expressions (case-insensitive) that keep the posting but flag it for a closer look.',
        ),
      })
      .prefault({})
      .describe('Working-hours rules.'),
  })
  .describe('Rule filter. Every rule is optional; every drop records a reason code.');

/* ------------------------------------------------------------------ scoring */

const scoringSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Score kept jobs with Claude before they are sent (requires ANTHROPIC_API_KEY and application.profile_file).',
      ),
    model: z.string().trim().min(1).default('claude-opus-5-5').describe('Anthropic model id.'),
    effort: z
      .enum(['low', 'medium', 'high'])
      .default('low')
      .describe('How hard the model thinks per job. "low" is enough for this classification.'),
    daily_budget_usd: z
      .number()
      .min(0)
      .default(1)
      .describe(
        'Hard cap on LLM spend per calendar day in user.timezone. Once reached, jobs are sent unscored until midnight.',
      ),
    pricing: z
      .strictObject({
        input: z.number().min(0).describe('USD per million input tokens.'),
        output: z.number().min(0).describe('USD per million output tokens.'),
        cache_read: z.number().min(0).optional().describe('USD per million cached input tokens.'),
      })
      .optional()
      .describe(
        'Prices for spend tracking. Built in for current Claude models; set it for any other model.',
      ),
    priorities: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(16).describe('Short label shown on cards.'),
          definition: z.string().trim().min(1).describe('What qualifies a job for this bucket.'),
        }),
      )
      .default([])
      .describe('Priority buckets, best first.'),
    industries: z
      .array(z.string().trim().min(1).max(60))
      .default([])
      .describe('Optional industry labels the model picks one from, written to the tracker.'),
    min_fit_score: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Do not send jobs scored below this (0-100). They stay searchable. Omit to send every kept job.',
      ),
    max_description_chars: z
      .number()
      .int()
      .min(1000)
      .max(100_000)
      .default(20_000)
      .describe('Longer descriptions are cut to this length before scoring, to bound cost.'),
  })
  .describe('Optional LLM scoring with Claude.');

/* ----------------------------------------------------------------- telegram */

const telegramSchema = z
  .strictObject({
    allowed_chat_ids: z
      .array(z.number().int())
      .default([])
      .describe(
        'Chats that receive cards and may use the bot. Leave empty on first start: /start replies with your chat ID.',
      ),
    rate_limit: z
      .strictObject({
        messages_per_minute: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(20)
          .describe('Upper bound on messages the bot sends per chat per minute.'),
      })
      .prefault({})
      .describe('Outgoing message throttling.'),
    batch_threshold: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(5)
      .describe(
        'When more than this many jobs are waiting, send one digest message instead of cards.',
      ),
    snooze_hours: z
      .array(
        z
          .number()
          .int()
          .min(1)
          .max(24 * 30),
      )
      .min(1)
      .max(6)
      .default([4, 24, 72])
      .describe('Choices offered by the Snooze button, in hours.'),
    reject_reasons: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(12)
      .default(['Location', 'Pay', 'Hours', 'Stack', 'Level', 'Not interested'])
      .describe('Choices offered by the Reject button. Stored to tune filters later.'),
    digest: z
      .strictObject({
        enabled: z.boolean().default(false).describe('Send a daily summary. Not implemented yet.'),
        time: timeOfDay.default('09:00').describe('Local time of the daily summary.'),
      })
      .prefault({})
      .describe('Scheduled daily digest.'),
  })
  .describe('Telegram delivery (requires TELEGRAM_BOT_TOKEN).');

/* ------------------------------------------------------------------ tracker */

/** Job fields the Notion adapter can write. */
export const NOTION_FIELDS = [
  'company',
  'title',
  'url',
  'links',
  'salary',
  'location',
  'work_format',
  'employment',
  'source',
  'priority',
  'status',
  'industry',
  'posted_at',
  'added_at',
] as const;

export type NotionField = (typeof NOTION_FIELDS)[number];

const notionField = z.enum(NOTION_FIELDS);

const notionSchema = z
  .strictObject({
    data_source_id: z
      .string()
      .trim()
      .min(1)
      .describe(
        'ID of the Notion data source to write to. In Notion: database menu → "Manage data sources" → copy the data source ID.',
      ),
    api_version: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a date such as "2026-03-11"')
      .default('2026-03-11')
      .describe('Notion-Version header sent with every request.'),
    properties: z
      .partialRecord(notionField, z.string().trim().min(1))
      .default({})
      .describe(
        `Job field -> your Notion property name. Fields: ${NOTION_FIELDS.join(', ')}. Property types are read from Notion, so any title, text, URL, select, multi-select, status, date or number property works. Unmapped fields are not written.`,
      ),
    values: z
      .partialRecord(notionField, z.record(z.string(), z.string().trim().min(1)))
      .default({})
      .describe(
        'Per-field value mapping, e.g. work_format: { remote: Remote, onsite: Office }. For `source` the keys are source ids or types and may end with "*", e.g. { "rss:board-*": Board, greenhouse: "Company website" }.',
      ),
    defaults: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .default({})
      .describe(
        'Values written on every insert, keyed by a job field from `properties` or by a Notion property name, e.g. status: "To Apply".',
      ),
    create_select_options: z
      .boolean()
      .default(false)
      .describe(
        'Let Notion create a missing select option. When false, a value that is not an existing option is skipped and reported on the card.',
      ),
    auto_number: z
      .strictObject({
        property: z
          .string()
          .trim()
          .min(1)
          .describe('Number property that receives a running number.'),
        strategy: z.enum(['max_plus_one']).default('max_plus_one'),
      })
      .optional()
      .describe('Optional running number for new rows: the current maximum plus one.'),
  })
  .describe('Notion adapter settings (requires NOTION_TOKEN).');

const trackerSchema = z
  .strictObject({
    type: z
      .enum(['postgres', 'notion'])
      .default('postgres')
      .describe(
        'Where "Add to tracker" writes. "postgres" is built in and needs no setup. Tracked jobs are always also recorded locally.',
      ),
    liveness_check: z
      .boolean()
      .default(true)
      .describe('Re-check that a posting is still open before adding it to the tracker.'),
    closed_patterns: regexList(
      'Extra regular expressions (case-insensitive) that mark a posting page as closed, for boards whose wording the built-in English patterns miss.',
    ),
    notion: notionSchema.optional(),
  })
  .describe('Application tracker.');

/* -------------------------------------------------------------- application */

const applicationSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Show the "Prepare application" button (requires ANTHROPIC_API_KEY and profile_file).',
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .default('claude-opus-5-5')
      .describe('Anthropic model id for drafts.'),
    effort: z
      .enum(['low', 'medium', 'high'])
      .default('medium')
      .describe('How hard the model thinks per draft.'),
    profile_file: z
      .string()
      .trim()
      .min(1)
      .default('profile.md')
      .describe(
        'Path to your profile, relative to the config file. Drafts use only facts written here.',
      ),
    language: z.string().trim().min(2).default('en').describe('Language of generated texts.'),
    cover_letter_max_words: z
      .number()
      .int()
      .min(50)
      .max(600)
      .default(180)
      .describe('Upper bound for the cover letter length.'),
    style_rules: keywordList('Free-form writing rules passed to the generator.'),
  })
  .describe(
    '"Prepare application" drafts: answers to the posting\'s questions (Greenhouse) and a short cover letter. Drafts count against scoring.daily_budget_usd.',
  );

/* --------------------------------------------------------------------- root */

export const configSchema = z
  .strictObject({
    user: userSchema,
    app: appSchema.prefault({}),
    schedule: scheduleSchema.prefault({}),
    sources: sourcesSchema.prefault({}),
    dedup: dedupSchema.prefault({}),
    filters: filtersSchema.prefault({}),
    scoring: scoringSchema.prefault({}),
    telegram: telegramSchema.prefault({}),
    tracker: trackerSchema.prefault({}),
    application: applicationSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.sources.rss.feeds.forEach((feed, index) => {
      if (seen.has(feed.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', 'rss', 'feeds', index, 'id'],
          message: `duplicate feed id "${feed.id}"`,
        });
      }
      seen.add(feed.id);
    });

    if (config.tracker.type === 'notion' && !config.tracker.notion) {
      ctx.addIssue({
        code: 'custom',
        path: ['tracker', 'notion'],
        message: 'required when tracker.type is "notion"',
      });
    }

    const labels = config.scoring.priorities.map((priority) => priority.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoring', 'priorities'],
        message: 'priority labels must be unique',
      });
    }

    if (config.scoring.enabled && config.scoring.priorities.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['scoring', 'priorities'],
        message: 'define at least one priority bucket when scoring is enabled',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type FiltersConfig = Config['filters'];
export type RssFeedConfig = Config['sources']['rss']['feeds'][number];
