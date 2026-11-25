import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One row per distinct job, however many boards it was found on. */
export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    fuzzyKey: text('fuzzy_key').notNull(),
    company: text('company'),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    locationText: text('location_text'),
    workMode: text('work_mode'),
    countries: jsonb('countries').$type<string[]>().notNull().default([]),
    regions: jsonb('regions').$type<string[]>().notNull().default([]),
    salaryMin: doublePrecision('salary_min'),
    salaryMax: doublePrecision('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: text('salary_period'),
    salaryText: text('salary_text'),
    employmentType: text('employment_type'),
    postedAt: timestamptz('posted_at'),
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    primaryUrl: text('primary_url').notNull(),
    primarySourceType: text('primary_source_type').notNull(),
    primarySourceId: text('primary_source_id').notNull(),
    /** Rule filter outcome: pass | flag | drop. */
    verdict: text('verdict').notNull(),
    dropReasons: jsonb('drop_reasons').$type<string[]>().notNull().default([]),
    flags: jsonb('flags').$type<string[]>().notNull().default([]),
    /** Specifics per reason or flag code, e.g. the keyword that matched. */
    filterDetails: jsonb('filter_details').$type<Record<string, string>>().notNull().default({}),
    /** What the user did with it: new | tracked | rejected. */
    state: text('state').notNull().default('new'),
    /** Stored during a source's first run without notifying anyone. */
    silent: boolean('silent').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('jobs_fuzzy_key_idx').on(table.fuzzyKey),
    index('jobs_created_at_idx').on(table.createdAt),
    index('jobs_verdict_idx').on(table.verdict),
  ],
);

/** Every place a job was seen. A job has one or more links. */
export const jobLinks = pgTable(
  'job_links',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    postedAt: timestamptz('posted_at'),
    raw: jsonb('raw'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_links_source_external_idx').on(table.sourceId, table.externalId),
    index('job_links_canonical_url_idx').on(table.canonicalUrl),
    index('job_links_job_id_idx').on(table.jobId),
  ],
);

/** Health and scheduling state per source instance (for example "greenhouse:board"). */
export const sourceState = pgTable('source_state', {
  sourceId: text('source_id').primaryKey(),
  sourceType: text('source_type').notNull(),
  initialized: boolean('initialized').notNull().default(false),
  lastRunAt: timestamptz('last_run_at'),
  lastSuccessAt: timestamptz('last_success_at'),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastFetched: integer('last_fetched').notNull().default(0),
  lastNew: integer('last_new').notNull().default(0),
  lastKept: integer('last_kept').notNull().default(0),
  lockedUntil: timestamptz('locked_until'),
});

export const sourceRuns = pgTable(
  'source_runs',
  {
    id: serial('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at').notNull(),
    ok: boolean('ok').notNull(),
    fetched: integer('fetched').notNull().default(0),
    created: integer('created').notNull().default(0),
    merged: integer('merged').notNull().default(0),
    kept: integer('kept').notNull().default(0),
    dropped: integer('dropped').notNull().default(0),
    error: text('error'),
  },
  (table) => [index('source_runs_source_started_idx').on(table.sourceId, table.startedAt)],
);

/** Validators for conditional requests (ETag / Last-Modified). No bodies are stored. */
export const httpCache = pgTable('http_cache', {
  url: text('url').primaryKey(),
  etag: text('etag'),
  lastModified: text('last_modified'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

/** Outbox: the worker inserts rows, the bot sends them. */
export const deliveries = pgTable(
  'deliveries',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    /** pending | sent | digested | failed | done */
    status: text('status').notNull().default('pending'),
    messageId: integer('message_id'),
    notBefore: timestamptz('not_before'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
  },
  (table) => [
    uniqueIndex('deliveries_job_chat_idx').on(table.jobId, table.chatId),
    index('deliveries_status_idx').on(table.status),
  ],
);

/** What the user decided about a job, kept to tune filters later. */
export const feedback = pgTable(
  'feedback',
  {
    id: serial('id').primaryKey(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    /** track | reject | snooze */
    action: text('action').notNull(),
    reason: text('reason'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('feedback_job_id_idx').on(table.jobId)],
);

/** Built-in tracker used when no external tracker is configured. */
export const trackerEntries = pgTable('tracker_entries', {
  id: serial('id').primaryKey(),
  jobId: integer('job_id')
    .notNull()
    .unique()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  company: text('company'),
  title: text('title').notNull(),
  url: text('url').notNull(),
  status: text('status').notNull().default('to_apply'),
  priority: text('priority'),
  source: text('source').notNull(),
  salary: text('salary'),
  location: text('location'),
  postedAt: timestamptz('posted_at'),
  addedAt: timestamptz('added_at').notNull().defaultNow(),
  /** Which tracker received it: "postgres", or an external one such as "notion". */
  tracker: text('tracker').notNull().default('postgres'),
  externalRef: text('external_ref'),
  externalUrl: text('external_url'),
});

/** Runtime overrides set through bot commands (pause, per-source switches). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
export type JobLinkRow = typeof jobLinks.$inferSelect;
export type DeliveryRow = typeof deliveries.$inferSelect;
export type SourceStateRow = typeof sourceState.$inferSelect;
export type TrackerEntryRow = typeof trackerEntries.$inferSelect;

/** One LLM assessment per job. */
export const llmScores = pgTable('llm_scores', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  priority: text('priority'),
  fitScore: integer('fit_score'),
  reason: text('reason'),
  stack: jsonb('stack').$type<string[]>().notNull().default([]),
  redFlags: jsonb('red_flags').$type<{ kind: string; note: string }[]>().notNull().default([]),
  industry: text('industry'),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

/** Spend per call, for the daily budget. */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: serial('id').primaryKey(),
    /** Calendar day in the user's time zone, "YYYY-MM-DD". */
    day: text('day').notNull(),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [index('llm_usage_day_idx').on(table.day)],
);

export type LlmScoreRow = typeof llmScores.$inferSelect;

/** Generated application drafts, one per job, so a second tap costs nothing. */
export const applicationDrafts = pgTable('application_drafts', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  coverLetter: text('cover_letter').notNull(),
  answers: jsonb('answers')
    .$type<
      { question: string; required: boolean; answer: string; needsInput: boolean; note: string }[]
    >()
    .notNull()
    .default([]),
  /** Questions found but deliberately not drafted (personal details, demographics). */
  skipped: jsonb('skipped').$type<string[]>().notNull().default([]),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export type ApplicationDraftRow = typeof applicationDrafts.$inferSelect;
