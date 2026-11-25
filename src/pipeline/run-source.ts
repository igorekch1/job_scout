import { eq } from 'drizzle-orm';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { sourceRuns, sourceState } from '../db/schema.js';
import { DbValidatorStore } from '../db/stores.js';
import type { HttpClient } from '../http/client.js';
import { HttpSession } from '../http/session.js';
import { errorMessage, type Logger } from '../logger.js';
import { buildAliases, type PlaceAlias } from '../normalize/gazetteer.js';
import { normalizeJob } from '../normalize/normalize.js';
import type { Source } from '../sources/types.js';
import { truncate } from '../util/text.js';
import { ingestJob } from './ingest.js';

export interface PipelineDeps {
  db: Db;
  config: Config;
  http: HttpClient;
  logger: Logger;
  now?: () => Date;
  aliases?: readonly PlaceAlias[];
}

export interface RunSummary {
  sourceId: string;
  ok: boolean;
  fetched: number;
  /** New jobs stored. */
  created: number;
  /** Postings recognised as a job already stored from another source. */
  merged: number;
  /** New jobs that passed the rule filter. */
  kept: number;
  dropped: number;
  error?: string;
}

/**
 * One collection run for one source: fetch, normalize, deduplicate, filter and queue.
 * Never throws: a failure is recorded on the source and reported in the summary, so one
 * broken source cannot stop the others.
 */
export async function runSource(source: Source, deps: PipelineDeps): Promise<RunSummary> {
  const { db, config, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const aliases = deps.aliases ?? buildAliases(config.filters.location.extra_aliases);
  const summary: RunSummary = {
    sourceId: source.id,
    ok: false,
    fetched: 0,
    created: 0,
    merged: 0,
    kept: 0,
    dropped: 0,
  };

  try {
    await db
      .insert(sourceState)
      .values({ sourceId: source.id, sourceType: source.type })
      .onConflictDoNothing();
    const [state] = await db
      .select()
      .from(sourceState)
      .where(eq(sourceState.sourceId, source.id))
      .limit(1);
    const firstRun = !state?.initialized;

    // On the first run always fetch in full, whatever validators an earlier install left behind.
    const session = new HttpSession(deps.http, new DbValidatorStore(db), !firstRun);
    const rawJobs = await source.fetch({ since: state?.lastSuccessAt ?? null, http: session });
    summary.fetched = rawJobs.length;

    for (const raw of rawJobs) {
      const job = normalizeJob(raw, source, {
        aliases,
        remoteKeywords: config.filters.location.remote_keywords,
      });
      const outcome = await ingestJob(db, job, { config, now: now(), firstRun });
      if (outcome.kind === 'merged') summary.merged += 1;
      if (outcome.kind === 'created') {
        summary.created += 1;
        if (outcome.filter.verdict === 'drop') summary.dropped += 1;
        else summary.kept += 1;
      }
    }

    await session.commit();
    summary.ok = true;
    const finishedAt = now();
    await db
      .update(sourceState)
      .set({
        initialized: true,
        lastRunAt: finishedAt,
        lastSuccessAt: finishedAt,
        lastError: null,
        consecutiveFailures: 0,
        lastFetched: summary.fetched,
        lastNew: summary.created,
        lastKept: summary.kept,
        lockedUntil: null,
      })
      .where(eq(sourceState.sourceId, source.id));
    logger.info({ ...summary }, 'source run finished');
  } catch (error) {
    summary.error = truncate(errorMessage(error), 300);
    logger.warn({ sourceId: source.id, err: error }, 'source run failed');
    try {
      const [state] = await db
        .select({ failures: sourceState.consecutiveFailures })
        .from(sourceState)
        .where(eq(sourceState.sourceId, source.id))
        .limit(1);
      await db
        .update(sourceState)
        .set({
          lastRunAt: now(),
          lastError: summary.error,
          consecutiveFailures: (state?.failures ?? 0) + 1,
          lockedUntil: null,
        })
        .where(eq(sourceState.sourceId, source.id));
    } catch (stateError) {
      logger.error({ sourceId: source.id, err: stateError }, 'could not record source failure');
    }
  }

  try {
    await db.insert(sourceRuns).values({
      sourceId: source.id,
      startedAt,
      finishedAt: now(),
      ok: summary.ok,
      fetched: summary.fetched,
      created: summary.created,
      merged: summary.merged,
      kept: summary.kept,
      dropped: summary.dropped,
      error: summary.error ?? null,
    });
  } catch (error) {
    logger.error({ sourceId: source.id, err: error }, 'could not record source run');
  }
  return summary;
}
