import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { deliveries, jobLinks, jobs } from '../db/schema.js';
import { atsFromUrl } from '../dedup/canonical-url.js';
import { fuzzyKey } from '../dedup/fuzzy-key.js';
import { filterJob, type FilterResult } from '../filters/index.js';
import type { Job } from '../normalize/job.js';

export type IngestOutcome =
  /** Already stored from this source. */
  | { kind: 'known' }
  /** Same job as one already stored: recorded as an extra link. */
  | { kind: 'merged'; jobId: number; promoted: boolean }
  | { kind: 'created'; jobId: number; filter: FilterResult; notified: boolean };

export interface IngestOptions {
  config: Config;
  now: Date;
  /** First run of the source: undated postings are stored without notifying anyone. */
  firstRun: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** An aggregator item that links straight to an employer ATS counts as that ATS. */
const effectiveType = (job: Job): string => atsFromUrl(job.url) ?? job.sourceType;

function priorityOf(type: string, order: readonly string[]): number {
  const index = order.indexOf(type);
  return index === -1 ? order.length : index;
}

const linkValues = (job: Job, jobId: number) => ({
  jobId,
  sourceType: job.sourceType,
  sourceId: job.sourceId,
  externalId: job.externalId,
  url: job.url,
  canonicalUrl: job.canonicalUrl,
  postedAt: job.postedAt,
  raw: job.raw,
});

/**
 * Stores one normalized job. Deduplicates by source id, then canonical URL, then the fuzzy
 * company+title key inside the configured window. New jobs are filtered and, when kept,
 * queued for delivery to every allowed chat.
 */
export async function ingestJob(db: Db, job: Job, options: IngestOptions): Promise<IngestOutcome> {
  const { config, now } = options;

  const [known] = await db
    .select({ id: jobLinks.id })
    .from(jobLinks)
    .where(and(eq(jobLinks.sourceId, job.sourceId), eq(jobLinks.externalId, job.externalId)))
    .limit(1);
  if (known) return { kind: 'known' };

  const key = fuzzyKey(job.company, job.title, job.canonicalUrl);
  const order = config.dedup.primary_source_priority;
  const type = effectiveType(job);

  return db.transaction(async (tx) => {
    // Two sources may deliver the same role at the same moment. Serialize on the dedup keys
    // (in a fixed order, so two transactions cannot deadlock) to keep it one job.
    for (const lockKey of [...new Set([key, `url:${job.canonicalUrl}`])].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    }

    const [sameUrl] = await tx
      .select({ jobId: jobLinks.jobId })
      .from(jobLinks)
      .where(eq(jobLinks.canonicalUrl, job.canonicalUrl))
      .limit(1);

    let existingId = sameUrl?.jobId;
    if (existingId === undefined && !key.startsWith('url:')) {
      const since = new Date(now.getTime() - config.dedup.window_days * DAY_MS);
      const [sameRole] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.fuzzyKey, key), gte(jobs.firstSeenAt, since)))
        .orderBy(desc(jobs.id))
        .limit(1);
      existingId = sameRole?.id;
    }

    if (existingId !== undefined) {
      await tx.insert(jobLinks).values(linkValues(job, existingId)).onConflictDoNothing();
      const [existing] = await tx.select().from(jobs).where(eq(jobs.id, existingId)).limit(1);
      const promoted =
        existing !== undefined &&
        priorityOf(type, order) < priorityOf(existing.primarySourceType, order);
      if (existing) {
        await tx
          .update(jobs)
          .set({
            ...(promoted
              ? { primaryUrl: job.url, primarySourceType: type, primarySourceId: job.sourceId }
              : {}),
            // the employer's own figures win; otherwise only fill what was missing
            ...(job.salary &&
            (promoted || (existing.salaryMin === null && existing.salaryMax === null))
              ? {
                  salaryMin: job.salary.min,
                  salaryMax: job.salary.max,
                  salaryCurrency: job.salary.currency,
                  salaryPeriod: job.salary.period,
                  salaryText: job.salary.text,
                }
              : {}),
            updatedAt: now,
          })
          .where(eq(jobs.id, existingId));
      }
      return { kind: 'merged', jobId: existingId, promoted };
    }

    const filter = filterJob(job, config, now);
    const silent = options.firstRun && job.postedAt === null;

    const [created] = await tx
      .insert(jobs)
      .values({
        fuzzyKey: key,
        company: job.company,
        title: job.title,
        description: job.description,
        locationText: job.location.text,
        workMode: job.location.workMode,
        countries: job.location.countries,
        regions: job.location.regions,
        salaryMin: job.salary?.min ?? null,
        salaryMax: job.salary?.max ?? null,
        salaryCurrency: job.salary?.currency ?? null,
        salaryPeriod: job.salary?.period ?? null,
        salaryText: job.salary?.text ?? null,
        employmentType: job.employmentType,
        postedAt: job.postedAt,
        firstSeenAt: now,
        primaryUrl: job.url,
        primarySourceType: type,
        primarySourceId: job.sourceId,
        verdict: filter.verdict,
        dropReasons: filter.dropReasons,
        flags: filter.flags,
        silent,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: jobs.id });
    const jobId = created!.id;
    await tx.insert(jobLinks).values(linkValues(job, jobId));

    const notified =
      filter.verdict !== 'drop' && !silent && config.telegram.allowed_chat_ids.length > 0;
    if (notified) {
      await tx
        .insert(deliveries)
        .values(
          config.telegram.allowed_chat_ids.map((chatId) => ({ jobId, chatId, createdAt: now })),
        )
        .onConflictDoNothing();
    }
    return { kind: 'created', jobId, filter, notified };
  });
}
