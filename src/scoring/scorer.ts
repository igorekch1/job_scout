import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { deliveries, jobs, llmScores } from '../db/schema.js';
import { dayIn, recordUsage, spentOn } from '../llm/budget.js';
import type { LlmClient } from '../llm/client.js';
import { costOf, type Pricing } from '../llm/pricing.js';
import { errorMessage, type Logger } from '../logger.js';
import {
  jobPrompt,
  profileContext,
  scoreSchema,
  scoringInstructions,
  type ScoreOutput,
} from './prompt.js';

export interface ScorerDeps {
  db: Db;
  config: Config;
  llm: LlmClient;
  pricing: Pricing;
  profile: string;
  logger: Logger;
  now?: () => Date;
}

export type ScoreOutcome = 'scored' | 'below_threshold' | 'unscored' | 'retry';

const MAX_ATTEMPTS = 3;
/** Jobs handled per pass; the rest wait for the next pass. */
const BATCH = 10;

const clean = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Scores jobs waiting in the outbox (delivery status "scoring") and then releases them for
 * sending. A job is never held back for long: when the budget is spent, the API keeps failing
 * or the model declines, it is released unscored.
 */
export class Scorer {
  private readonly attempts = new Map<number, number>();
  private readonly now: () => Date;
  private readonly instructions: string;
  private readonly context: string;
  private readonly schema: ReturnType<typeof scoreSchema>;
  private busy = false;
  private budgetNoticeDay: string | undefined;

  constructor(private readonly deps: ScorerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.instructions = scoringInstructions(deps.config);
    this.context = profileContext(deps.profile);
    this.schema = scoreSchema(deps.config);
  }

  /** Handles up to one batch of waiting jobs. Safe to call often. */
  async process(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let handled = 0;
    try {
      const waiting = await this.deps.db
        .selectDistinct({ jobId: deliveries.jobId })
        .from(deliveries)
        .where(eq(deliveries.status, 'scoring'))
        .orderBy(asc(deliveries.jobId))
        .limit(BATCH);
      for (const { jobId } of waiting) {
        const outcome = await this.scoreJob(jobId);
        if (outcome !== 'retry') handled += 1;
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'scoring pass failed');
    } finally {
      this.busy = false;
    }
    return handled;
  }

  private async release(jobId: number, status: 'pending' | 'skipped'): Promise<void> {
    await this.deps.db
      .update(deliveries)
      .set({ status })
      .where(and(eq(deliveries.jobId, jobId), eq(deliveries.status, 'scoring')));
  }

  async scoreJob(jobId: number): Promise<ScoreOutcome> {
    const { db, config, logger } = this.deps;
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) return 'unscored';

    const [existing] = await db.select().from(llmScores).where(eq(llmScores.jobId, jobId)).limit(1);
    if (existing) {
      await this.release(jobId, this.belowThreshold(existing.fitScore) ? 'skipped' : 'pending');
      return 'scored';
    }

    const at = this.now();
    const day = dayIn(at, config.user.timezone);
    if ((await spentOn(db, day)) >= config.scoring.daily_budget_usd) {
      if (this.budgetNoticeDay !== day) {
        logger.warn(
          { day, budget: config.scoring.daily_budget_usd },
          'daily LLM budget reached; sending jobs unscored',
        );
        this.budgetNoticeDay = day;
      }
      await this.release(jobId, 'pending');
      return 'unscored';
    }

    let result;
    try {
      result = await this.deps.llm.generate({
        instructions: this.instructions,
        context: this.context,
        prompt: jobPrompt(job, config),
        schema: this.schema,
      });
    } catch (error) {
      const attempts = (this.attempts.get(jobId) ?? 0) + 1;
      this.attempts.set(jobId, attempts);
      logger.warn({ jobId, attempts, err: error }, `scoring failed: ${errorMessage(error)}`);
      if (attempts < MAX_ATTEMPTS) return 'retry';
      this.attempts.delete(jobId);
      await this.release(jobId, 'pending');
      return 'unscored';
    }
    this.attempts.delete(jobId);

    const costUsd = costOf(result.usage, this.deps.pricing);
    await recordUsage(db, {
      day,
      purpose: 'score',
      model: result.model,
      usage: result.usage,
      costUsd,
      at,
    });

    if (!result.output) {
      logger.warn({ jobId, refused: result.refused }, 'model returned no score; sending unscored');
      await this.release(jobId, 'pending');
      return 'unscored';
    }

    const output: ScoreOutput = result.output;
    const fitScore = Math.round(Math.min(100, Math.max(0, output.fit_score)));
    await db
      .insert(llmScores)
      .values({
        jobId,
        model: result.model,
        priority: output.priority,
        fitScore,
        reason: clean(output.reason, 240),
        stack: output.stack
          .map((item) => clean(item, 40))
          .filter(Boolean)
          .slice(0, 8),
        redFlags: output.red_flags
          .map((flag) => ({ kind: flag.kind, note: clean(flag.note, 200) }))
          .slice(0, 6),
        industry: output.industry ?? null,
        costUsd,
        createdAt: at,
      })
      .onConflictDoNothing();

    const below = this.belowThreshold(fitScore);
    await this.release(jobId, below ? 'skipped' : 'pending');
    return below ? 'below_threshold' : 'scored';
  }

  private belowThreshold(fitScore: number | null): boolean {
    const minimum = this.deps.config.scoring.min_fit_score;
    return minimum !== undefined && fitScore !== null && fitScore < minimum;
  }
}

/** Scores for a set of jobs, keyed by job id. */
export async function loadScores(db: Db, jobIds: number[]) {
  if (jobIds.length === 0) return new Map<number, typeof llmScores.$inferSelect>();
  const rows = await db.select().from(llmScores).where(inArray(llmScores.jobId, jobIds));
  return new Map(rows.map((row) => [row.jobId, row]));
}
