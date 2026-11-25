import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { GrammyError, type Api } from 'grammy';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { deliveries, jobLinks, jobs, type JobLinkRow } from '../db/schema.js';
import { isPaused } from '../db/stores.js';
import { errorMessage, type Logger } from '../logger.js';
import { truncate } from '../util/text.js';
import { loadScores } from '../scoring/scorer.js';
import { mainKeyboard, renderCard, renderDigest } from './cards.js';

export interface OutboxDeps {
  db: Db;
  config: Config;
  api: Api;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface OutboxResult {
  cards: number;
  digests: number;
  failed: number;
}

const MAX_ATTEMPTS = 5;
/** Upper bound of jobs handled per chat in one pass. */
const PAGE = 100;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends queued jobs to Telegram. All outgoing job messages go through here, so there is one
 * rate limiter and one place that decides between single cards and a digest.
 */
export class Outbox {
  private readonly lastSent = new Map<number, number>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.intervalMs = Math.ceil(60_000 / deps.config.telegram.rate_limit.messages_per_minute);
  }

  start(everyMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Spaces messages to one chat so the configured per-minute limit is never exceeded. */
  private async throttle(chatId: number): Promise<void> {
    const wait = (this.lastSent.get(chatId) ?? -Infinity) + this.intervalMs - this.now().getTime();
    if (wait > 0) await this.sleep(wait);
    this.lastSent.set(chatId, this.now().getTime());
  }

  private async send(chatId: number, text: string, keyboard?: ReturnType<typeof mainKeyboard>) {
    await this.throttle(chatId);
    return this.deps.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async tick(): Promise<OutboxResult> {
    const result: OutboxResult = { cards: 0, digests: 0, failed: 0 };
    if (this.busy) return result;
    this.busy = true;
    try {
      if (await isPaused(this.deps.db)) return result;
      for (const chatId of this.deps.config.telegram.allowed_chat_ids) {
        await this.flushChat(chatId, result);
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'outbox tick failed');
    } finally {
      this.busy = false;
    }
    return result;
  }

  private async flushChat(chatId: number, result: OutboxResult): Promise<void> {
    const { db, config, logger } = this.deps;
    const now = this.now();
    const due = and(
      eq(deliveries.chatId, chatId),
      eq(deliveries.status, 'pending'),
      or(isNull(deliveries.notBefore), lte(deliveries.notBefore, now)),
    );

    // jobs already tracked or rejected elsewhere need no card any more
    const stale = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .innerJoin(jobs, eq(jobs.id, deliveries.jobId))
      .where(and(due, ne(jobs.state, 'new')));
    if (stale.length > 0) {
      await db
        .update(deliveries)
        .set({ status: 'done' })
        .where(
          inArray(
            deliveries.id,
            stale.map((row) => row.id),
          ),
        );
    }

    const rows = await db
      .select({ delivery: deliveries, job: jobs })
      .from(deliveries)
      .innerJoin(jobs, eq(jobs.id, deliveries.jobId))
      .where(and(due, eq(jobs.state, 'new')))
      .orderBy(asc(deliveries.id))
      .limit(PAGE);
    if (rows.length === 0) return;
    const scores = await loadScores(
      db,
      rows.map((row) => row.job.id),
    );

    if (rows.length > config.telegram.batch_threshold) {
      try {
        const title = `${rows.length} new matching jobs`;
        const order = config.scoring.priorities.map((priority) => priority.label);
        for (const message of renderDigest(
          rows.map((row) => row.job),
          title,
          scores,
          order,
        )) {
          await this.send(chatId, message);
        }
        await db
          .update(deliveries)
          .set({ status: 'digested', sentAt: this.now(), notBefore: null })
          .where(
            inArray(
              deliveries.id,
              rows.map((row) => row.delivery.id),
            ),
          );
        result.digests += 1;
      } catch (error) {
        logger.warn({ chatId, err: error }, 'could not send digest');
        await this.backOff(error);
      }
      return;
    }

    const links = await db
      .select()
      .from(jobLinks)
      .where(
        inArray(
          jobLinks.jobId,
          rows.map((row) => row.job.id),
        ),
      )
      .orderBy(asc(jobLinks.id));
    const linksByJob = new Map<number, JobLinkRow[]>();
    for (const link of links) {
      linksByJob.set(link.jobId, [...(linksByJob.get(link.jobId) ?? []), link]);
    }

    for (const { delivery, job } of rows) {
      try {
        const text = renderCard(
          { job, links: linksByJob.get(job.id) ?? [], score: scores.get(job.id) ?? null },
          config,
        );
        const message = await this.send(chatId, text, mainKeyboard(job.id));
        await db
          .update(deliveries)
          .set({
            status: 'sent',
            messageId: message.message_id,
            sentAt: this.now(),
            notBefore: null,
          })
          .where(eq(deliveries.id, delivery.id));
        result.cards += 1;
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const blocked = error instanceof GrammyError && error.error_code === 403;
        const failed = blocked || attempts >= MAX_ATTEMPTS;
        await db
          .update(deliveries)
          .set({
            attempts,
            lastError: truncate(errorMessage(error), 300),
            status: failed ? 'failed' : 'pending',
          })
          .where(eq(deliveries.id, delivery.id));
        if (failed) result.failed += 1;
        logger.warn({ chatId, jobId: job.id, attempts, err: error }, 'could not send card');
        // a rate limit or an unreachable chat affects the rest of the queue too
        if (await this.backOff(error)) return;
        if (blocked) return;
      }
    }
  }

  /** Waits out a Telegram rate limit. Returns true when the caller should stop this pass. */
  private async backOff(error: unknown): Promise<boolean> {
    if (error instanceof GrammyError && error.error_code === 429) {
      const seconds = error.parameters.retry_after ?? 5;
      await this.sleep(Math.min(seconds, 120) * 1000);
      return true;
    }
    return false;
  }
}
