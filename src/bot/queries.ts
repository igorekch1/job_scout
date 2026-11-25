import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { deliveries, feedback, jobLinks, jobs, trackerEntries } from '../db/schema.js';
import type { TrackerEntry, TrackerResult } from '../trackers/types.js';
import type { CardData } from './cards.js';

export async function loadCard(db: Db, jobId: number): Promise<CardData | undefined> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return undefined;
  const links = await db
    .select()
    .from(jobLinks)
    .where(eq(jobLinks.jobId, jobId))
    .orderBy(jobLinks.id);
  return { job, links };
}

export type JobState = 'new' | 'tracked' | 'rejected' | 'closed';

/** Records the user's decision and closes the job's deliveries in every chat. */
export async function resolveJob(
  db: Db,
  input: {
    jobId: number;
    chatId: number;
    state: JobState;
    action: string;
    reason?: string;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(jobs)
      .set({ state: input.state, updatedAt: input.now })
      .where(eq(jobs.id, input.jobId));
    await tx.insert(feedback).values({
      jobId: input.jobId,
      chatId: input.chatId,
      action: input.action,
      reason: input.reason ?? null,
      createdAt: input.now,
    });
    await tx
      .update(deliveries)
      .set({ status: 'done', notBefore: null })
      .where(
        and(
          eq(deliveries.jobId, input.jobId),
          inArray(deliveries.status, ['pending', 'sent', 'digested']),
        ),
      );
  });
}

/** Puts the job back into the outbox for this chat, to be sent again at `until`. */
export async function snoozeJob(
  db: Db,
  input: { jobId: number; chatId: number; until: Date; now: Date },
): Promise<void> {
  await db.transaction(async (tx) => {
    const pending = { status: 'pending', notBefore: input.until, messageId: null, attempts: 0 };
    await tx
      .insert(deliveries)
      .values({ jobId: input.jobId, chatId: input.chatId, createdAt: input.now, ...pending })
      .onConflictDoUpdate({ target: [deliveries.jobId, deliveries.chatId], set: pending });
    await tx.insert(feedback).values({
      jobId: input.jobId,
      chatId: input.chatId,
      action: 'snooze',
      reason: input.until.toISOString(),
      createdAt: input.now,
    });
  });
}

export interface Counts {
  found: number;
  kept: number;
  dropped: number;
  tracked: number;
  rejected: number;
  waiting: number;
}

export async function loadCounts(db: Db): Promise<Counts> {
  const [totals] = await db
    .select({
      found: count(),
      kept: sql<number>`count(*) filter (where ${jobs.verdict} <> 'drop')`.mapWith(Number),
      dropped: sql<number>`count(*) filter (where ${jobs.verdict} = 'drop')`.mapWith(Number),
      rejected: sql<number>`count(*) filter (where ${jobs.state} = 'rejected')`.mapWith(Number),
    })
    .from(jobs);
  const [tracked] = await db.select({ value: count() }).from(trackerEntries);
  const [waiting] = await db
    .select({ value: count() })
    .from(deliveries)
    .where(eq(deliveries.status, 'pending'));
  return {
    found: totals?.found ?? 0,
    kept: totals?.kept ?? 0,
    dropped: totals?.dropped ?? 0,
    rejected: totals?.rejected ?? 0,
    tracked: tracked?.value ?? 0,
    waiting: waiting?.value ?? 0,
  };
}

/** Keeps a local record of a job sent to an external tracker, for counts and history. */
export async function recordExternal(
  db: Db,
  entry: TrackerEntry,
  trackerId: string,
  result: TrackerResult,
): Promise<void> {
  await db
    .insert(trackerEntries)
    .values({
      jobId: entry.jobId,
      company: entry.company,
      title: entry.title,
      url: entry.url,
      priority: entry.priority,
      source: entry.source,
      salary: entry.salary,
      location: entry.location,
      postedAt: entry.postedAt,
      addedAt: entry.addedAt,
      tracker: trackerId,
      externalRef: result.ref,
      externalUrl: result.url ?? null,
    })
    .onConflictDoNothing({ target: trackerEntries.jobId });
}
