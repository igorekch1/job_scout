import { Bot, GrammyError, type Context, type InlineKeyboard } from 'grammy';
import type { BotFullInfo } from 'grammy/types';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import {
  getSetting,
  getSourceStates,
  isPaused,
  setSetting,
  SETTING_PAUSED,
  SETTING_WORKER_HEARTBEAT,
} from '../db/stores.js';
import { describeFilters } from '../filters/index.js';
import type { HttpClient } from '../http/client.js';
import { checkLiveness } from '../liveness/check.js';
import { dayIn, spentOn } from '../llm/budget.js';
import { errorMessage, type Logger } from '../logger.js';
import { formatSalary } from '../normalize/salary.js';
import { buildSources } from '../sources/registry.js';
import type { Tracker, TrackerEntry } from '../trackers/types.js';
import { truncate } from '../util/text.js';
import {
  escapeHtml,
  formatDate,
  locationLine,
  mainKeyboard,
  rejectKeyboard,
  renderCard,
  salaryOfRow,
  snoozeKeyboard,
  unknownLivenessKeyboard,
  type CardData,
} from './cards.js';
import { loadCard, loadCounts, recordExternal, resolveJob, snoozeJob } from './queries.js';

export interface BotDeps {
  token: string;
  db: Db;
  config: Config;
  tracker: Tracker;
  http: HttpClient;
  logger: Logger;
  now?: () => Date;
  /** Skips the getMe call at startup; used by tests. */
  botInfo?: BotFullInfo;
}

export const COMMANDS = [
  { command: 'status', description: 'Sources health, last runs and counts' },
  { command: 'filters', description: 'Show the active filter rules' },
  { command: 'pause', description: 'Stop collecting and sending jobs' },
  { command: 'resume', description: 'Resume after /pause' },
  { command: 'help', description: 'What this bot does' },
] as const;

const HELP = [
  '<b>job-scout</b> watches the job sources in your config, filters new postings against your rules and sends each match here as a card.',
  '',
  '<b>Buttons on a card</b>',
  '✅ Add to tracker: checks the posting is still open, then saves it',
  '❌ Reject: pick a reason; reasons are stored to tune filters',
  '💤 Later: hides the card and sends it again after the chosen time',
  '',
  '<b>Commands</b>',
  ...COMMANDS.map(({ command, description }) => `/${command}: ${description}`),
  '',
  'The bot never applies to jobs or contacts employers for you.',
].join('\n');

export function ago(date: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

export function createBot(deps: BotDeps): Bot {
  const { db, config, tracker, http, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const allowed = new Set(config.telegram.allowed_chat_ids);
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  /* ----------------------------------------------------------- access */

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined && allowed.has(chatId)) return next();
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'This bot is private.' });
    } else if (chatId !== undefined && ctx.message?.text?.startsWith('/start')) {
      await ctx.reply(
        `This bot is private.\n\nYour chat ID is <code>${chatId}</code>. Add it to <code>telegram.allowed_chat_ids</code> in config.yaml and restart the bot and the worker.`,
        HTML,
      );
    }
  });

  /* --------------------------------------------------------- commands */

  bot.command('start', (ctx) =>
    ctx.reply(`You are set up: matching jobs will arrive in this chat.\n\n${HELP}`, HTML),
  );
  bot.command('help', (ctx) => ctx.reply(HELP, HTML));

  bot.command('pause', async (ctx) => {
    await setSetting(db, SETTING_PAUSED, true);
    await ctx.reply('⏸ Paused. Nothing is collected or sent until /resume.');
  });

  bot.command('resume', async (ctx) => {
    await setSetting(db, SETTING_PAUSED, false);
    await ctx.reply('▶️ Resumed.');
  });

  bot.command('filters', async (ctx) => {
    const lines = describeFilters(config).map((line) => `• ${escapeHtml(line)}`);
    await ctx.reply(`<b>Active filter rules</b>\n${lines.join('\n')}`, HTML);
  });

  bot.command('status', async (ctx) => {
    const at = now();
    const [paused, heartbeat, states, counts, health] = await Promise.all([
      isPaused(db),
      getSetting<string>(db, SETTING_WORKER_HEARTBEAT),
      getSourceStates(db),
      loadCounts(db),
      tracker.health?.(),
    ]);
    const spent = config.scoring.enabled
      ? await spentOn(db, dayIn(at, config.user.timezone))
      : undefined;
    const { sources, unsupported } = buildSources(config);

    const lines = [
      `<b>Status:</b> ${paused ? '⏸ paused' : '▶️ running'}`,
      `<b>Worker:</b> ${heartbeat ? `last seen ${ago(new Date(heartbeat), at)}` : 'not seen yet'}`,
      `<b>Jobs:</b> ${counts.found} found · ${counts.kept} kept · ${counts.dropped} dropped`,
      ...(spent !== undefined
        ? [
            `<b>LLM:</b> $${spent.toFixed(2)} of $${config.scoring.daily_budget_usd.toFixed(2)} today (${escapeHtml(config.scoring.model)})`,
          ]
        : []),
      `<b>Tracker:</b> ${escapeHtml(tracker.id)}${health ? ` ${health.ok ? '✅' : `❌ ${escapeHtml(truncate(health.detail, 200))}`}` : ''}`,
      `<b>Yours:</b> ${counts.tracked} tracked · ${counts.rejected} rejected · ${counts.waiting} waiting`,
      '',
      '<b>Sources</b>',
    ];
    if (sources.length === 0) lines.push('No sources are enabled in config.yaml.');
    for (const source of sources) {
      const state = states.get(source.id);
      const id = escapeHtml(source.id);
      if (!state?.lastRunAt) {
        lines.push(`⏳ ${id}: not run yet`);
      } else if (state.lastError) {
        const failures = `${state.consecutiveFailures} failure${state.consecutiveFailures === 1 ? '' : 's'}`;
        lines.push(
          `❌ ${id}: ${ago(state.lastRunAt, at)}, ${escapeHtml(truncate(state.lastError, 120))} (${failures})`,
        );
      } else {
        lines.push(
          `✅ ${id}: ${ago(state.lastRunAt, at)}, ${state.lastFetched} fetched, ${state.lastNew} new, ${state.lastKept} kept`,
        );
      }
    }
    for (const type of unsupported)
      lines.push(`🚧 ${escapeHtml(type)}: enabled but not implemented yet`);
    await ctx.reply(lines.join('\n'), HTML);
  });

  /* ------------------------------------------------------------ cards */

  const statusOf = (card: CardData): string | undefined => {
    switch (card.job.state) {
      case 'tracked':
        return '✅ In tracker';
      case 'rejected':
        return '❌ Rejected';
      case 'closed':
        return '⛔ Posting is closed';
      default:
        return undefined;
    }
  };

  /** Rewrites the card message. Telegram rejects an edit that changes nothing: ignore that. */
  const edit = async (ctx: Context, card: CardData, status?: string, keyboard?: InlineKeyboard) => {
    try {
      await ctx.editMessageText(renderCard(card, config, status), {
        ...HTML,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes('message is not modified'))
        return;
      throw error;
    }
  };

  /** Loads the job behind a button press; answers the query itself when it cannot proceed. */
  const cardFor = async (ctx: Context, jobId: number): Promise<CardData | undefined> => {
    const card = await loadCard(db, jobId);
    if (!card) {
      await ctx.answerCallbackQuery({ text: 'This job is no longer stored.' });
      return undefined;
    }
    const status = statusOf(card);
    if (status) {
      await ctx.answerCallbackQuery({ text: 'Already handled.' });
      await edit(ctx, card, status);
      return undefined;
    }
    return card;
  };

  // /job_12 from a digest opens the full card
  bot.hears(/^\/job_(\d+)(?:@\w+)?$/, async (ctx) => {
    const card = await loadCard(db, Number(ctx.match[1]));
    if (!card) {
      await ctx.reply('No such job.');
      return;
    }
    const status = statusOf(card);
    await ctx.reply(renderCard(card, config, status), {
      ...HTML,
      ...(status ? {} : { reply_markup: mainKeyboard(card.job.id) }),
    });
  });

  const addToTracker = async (ctx: Context, card: CardData): Promise<void> => {
    const { job, links } = card;
    const at = now();
    try {
      const entry: TrackerEntry = {
        jobId: job.id,
        company: job.company,
        title: job.title,
        url: job.primaryUrl,
        links: [
          job.primaryUrl,
          ...links.map((link) => link.url).filter((url) => url !== job.primaryUrl),
        ],
        source: job.primarySourceType,
        sourceId: job.primarySourceId,
        salary: formatSalary(salaryOfRow(job)),
        location: locationLine(job),
        workMode: job.workMode,
        employmentType: job.employmentType,
        priority: card.score?.priority ?? null,
        industry: card.score?.industry ?? null,
        postedAt: job.postedAt,
        addedAt: at,
      };
      const result = await tracker.add(entry);
      if (tracker.id !== 'postgres') await recordExternal(db, entry, tracker.id, result);
      await resolveJob(db, {
        jobId: job.id,
        chatId: ctx.chat!.id,
        state: 'tracked',
        action: 'track',
        now: at,
      });
      const where = result.url ? `<a href="${escapeHtml(result.url)}">tracker</a>` : 'tracker';
      const skipped = result.skipped?.length
        ? `\n⚠️ Not written: ${escapeHtml(truncate(result.skipped.join('; '), 300))}`
        : '';
      await edit(
        ctx,
        { ...card, job: { ...job, state: 'tracked' } },
        `${result.duplicate ? `✅ Already in ${where}` : `✅ Added to ${where}`}${skipped}`,
      );
    } catch (error) {
      logger.error({ jobId: job.id, err: error }, 'tracker insert failed');
      await edit(
        ctx,
        card,
        `⚠️ Could not add to tracker: ${escapeHtml(truncate(errorMessage(error), 200))}`,
        mainKeyboard(job.id),
      );
    }
  };

  bot.callbackQuery(/^t:(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    if (!config.tracker.liveness_check) {
      await ctx.answerCallbackQuery();
      await addToTracker(ctx, card);
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Checking that the posting is still open…' });
    const liveness = await checkLiveness(
      { primaryUrl: card.job.primaryUrl, links: card.links },
      http,
      { closedPatterns: config.tracker.closed_patterns },
    );
    if (liveness.status === 'closed') {
      await resolveJob(db, {
        jobId: card.job.id,
        chatId: ctx.chat!.id,
        state: 'closed',
        action: 'closed',
        reason: liveness.detail,
        now: now(),
      });
      await edit(ctx, card, `⛔ Not added: ${escapeHtml(liveness.detail)}.`);
    } else if (liveness.status === 'unknown') {
      await edit(
        ctx,
        card,
        `⚠️ Could not verify that the posting is still open (${escapeHtml(truncate(liveness.detail, 120))}).`,
        unknownLivenessKeyboard(card.job.id),
      );
    } else {
      await addToTracker(ctx, card);
    }
  });

  bot.callbackQuery(/^ta:(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    await ctx.answerCallbackQuery();
    await addToTracker(ctx, card);
  });

  bot.callbackQuery(/^r:(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      card,
      'Why reject it?',
      rejectKeyboard(card.job.id, config.telegram.reject_reasons),
    );
  });

  bot.callbackQuery(/^rr:(\d+):(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    const reason = config.telegram.reject_reasons[Number(ctx.match[2])];
    if (!reason) {
      await ctx.answerCallbackQuery({ text: 'That reason no longer exists. Pick again.' });
      await edit(
        ctx,
        card,
        'Why reject it?',
        rejectKeyboard(card.job.id, config.telegram.reject_reasons),
      );
      return;
    }
    await resolveJob(db, {
      jobId: card.job.id,
      chatId: ctx.chat!.id,
      state: 'rejected',
      action: 'reject',
      reason,
      now: now(),
    });
    await ctx.answerCallbackQuery({ text: 'Rejected' });
    await edit(ctx, card, `❌ Rejected: ${escapeHtml(reason)}`);
  });

  bot.callbackQuery(/^s:(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    await ctx.answerCallbackQuery();
    await edit(
      ctx,
      card,
      'Remind me in…',
      snoozeKeyboard(card.job.id, config.telegram.snooze_hours),
    );
  });

  bot.callbackQuery(/^ss:(\d+):(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    const hours = Number(ctx.match[2]);
    if (!config.telegram.snooze_hours.includes(hours)) {
      await ctx.answerCallbackQuery({ text: 'That option no longer exists. Pick again.' });
      await edit(
        ctx,
        card,
        'Remind me in…',
        snoozeKeyboard(card.job.id, config.telegram.snooze_hours),
      );
      return;
    }
    const at = now();
    const until = new Date(at.getTime() + hours * 60 * 60 * 1000);
    await snoozeJob(db, { jobId: card.job.id, chatId: ctx.chat!.id, until, now: at });
    await ctx.answerCallbackQuery({ text: 'Snoozed' });
    await edit(ctx, card, `💤 Snoozed until ${formatDate(until, config.user.timezone, true)}`);
  });

  bot.callbackQuery(/^b:(\d+)$/, async (ctx) => {
    const card = await cardFor(ctx, Number(ctx.match[1]));
    if (!card) return;
    await ctx.answerCallbackQuery();
    await edit(ctx, card, undefined, mainKeyboard(card.job.id));
  });

  bot.on('callback_query', (ctx) => ctx.answerCallbackQuery({ text: 'Unknown action.' }));

  bot.catch((failure) => {
    logger.error({ err: failure.error, updateId: failure.ctx.update.update_id }, 'update failed');
  });

  return bot;
}
