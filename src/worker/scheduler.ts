import type { SourceStateRow } from '../db/schema.js';
import {
  claimSource,
  getDisabledSources,
  getSourceStates,
  isPaused,
  setSetting,
  SETTING_WORKER_HEARTBEAT,
} from '../db/stores.js';
import { runSource, type PipelineDeps, type RunSummary } from '../pipeline/run-source.js';
import type { Source } from '../sources/types.js';

export interface SchedulerOptions {
  maxConcurrent: number;
  /** How often to look for due sources. */
  tickMs?: number;
  /** Upper bound for one run; the run lock expires after it. */
  lockMs?: number;
}

const MINUTE = 60_000;
/** A failing source is retried less often, up to this multiple of its interval. */
const MAX_BACKOFF_FACTOR = 8;

/** When the source should run next, given its last run and failure streak. */
export function nextRunAt(source: Source, state: SourceStateRow | undefined): Date {
  if (!state?.lastRunAt) return new Date(0);
  const factor = Math.min(MAX_BACKOFF_FACTOR, 2 ** state.consecutiveFailures);
  return new Date(state.lastRunAt.getTime() + source.intervalMinutes * MINUTE * factor);
}

/**
 * Runs every source on its own interval. State lives in the database, so a restart does not
 * re-fetch everything, and a per-source lock prevents overlapping runs.
 */
export class Scheduler {
  private readonly running = new Map<string, Promise<RunSummary>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly tickMs: number;
  private readonly lockMs: number;

  constructor(
    private readonly sources: readonly Source[],
    private readonly deps: PipelineDeps,
    private readonly options: SchedulerOptions,
  ) {
    this.tickMs = options.tickMs ?? 15_000;
    this.lockMs = options.lockMs ?? 10 * MINUTE;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  /** Stops scheduling and waits for runs in flight. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.running.values());
  }

  /** Starts every due source, up to the concurrency limit. Returns the runs it started. */
  async tick(): Promise<Promise<RunSummary>[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: Promise<RunSummary>[] = [];
    const { db, logger } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();

    try {
      await setSetting(db, SETTING_WORKER_HEARTBEAT, now.toISOString());
      if (await isPaused(db)) return started;

      const states = await getSourceStates(db);
      const disabled = await getDisabledSources(db);
      const due = this.sources
        .filter((source) => !disabled.has(source.id))
        .filter((source) => !this.running.has(source.id))
        .filter((source) => nextRunAt(source, states.get(source.id)) <= now)
        .sort(
          (a, b) =>
            nextRunAt(a, states.get(a.id)).getTime() - nextRunAt(b, states.get(b.id)).getTime(),
        );

      for (const source of due) {
        if (this.running.size >= this.options.maxConcurrent) break;
        if (!(await claimSource(db, source, now, this.lockMs))) continue;
        const run = runSource(source, this.deps).finally(() => this.running.delete(source.id));
        this.running.set(source.id, run);
        started.push(run);
      }
    } catch (error) {
      logger.error({ err: error }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }
    return started;
  }
}
