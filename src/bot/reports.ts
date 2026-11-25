import { and, count, desc, eq, gte, ilike, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import {
  feedback,
  jobs,
  llmScores,
  sourceState,
  trackerEntries,
  type JobRow,
} from '../db/schema.js';
import { describeReason } from '../filters/types.js';
import { dayIn, spentOn } from '../llm/budget.js';
import { formatSalary } from '../normalize/salary.js';
import { escapeRegex, truncate } from '../util/text.js';
import { escapeHtml, locationLine, salaryOfRow, scoreBadge } from './cards.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_PICKS = 10;

const jobLine = (job: JobRow, badge: string | null): string => {
  const parts = [badge, job.company, formatSalary(salaryOfRow(job)), locationLine(job)]
    .filter((part): part is string => Boolean(part))
    .map((part) => escapeHtml(truncate(part, 60)));
  return `<b>${escapeHtml(truncate(job.title, 90))}</b>\n  ${parts.join(' · ')}\n  /job_${job.id}`;
};

const money = (value: number): string => `$${value.toFixed(2)}`;

/** Summary of the last 24 hours: counts, best new jobs, failing sources. */
export async function buildDigest(db: Db, config: Config, now: Date): Promise<string> {
  const since = new Date(now.getTime() - DAY_MS);
  const [totals] = await db
    .select({
      found: count(),
      kept: sql<number>`count(*) filter (where ${jobs.verdict} <> 'drop')`.mapWith(Number),
      dropped: sql<number>`count(*) filter (where ${jobs.verdict} = 'drop')`.mapWith(Number),
    })
    .from(jobs)
    .where(gte(jobs.createdAt, since));

  const fresh = await db
    .select({ job: jobs, score: llmScores })
    .from(jobs)
    .leftJoin(llmScores, eq(llmScores.jobId, jobs.id))
    .where(and(gte(jobs.createdAt, since), ne(jobs.verdict, 'drop'), eq(jobs.silent, false)));
  const waiting = fresh.filter((row) => row.job.state === 'new');

  const order = config.scoring.priorities.map((priority) => priority.label);
  const rank = (row: (typeof fresh)[number]): [number, number, number] => {
    const index = row.score?.priority ? order.indexOf(row.score.priority) : -1;
    return [
      index === -1 ? order.length : index,
      -(row.score?.fitScore ?? -1),
      -row.job.createdAt.getTime(),
    ];
  };
  const picks = [...waiting]
    .sort((a, b) => {
      const [pa, sa, ta] = rank(a);
      const [pb, sb, tb] = rank(b);
      return pa - pb || sa - sb || ta - tb;
    })
    .slice(0, TOP_PICKS);

  const failing = await db
    .select()
    .from(sourceState)
    .where(and(isNotNull(sourceState.lastError), gte(sourceState.consecutiveFailures, 1)));

  const lines = [
    '<b>Digest for the last 24 hours</b>',
    `${totals?.found ?? 0} found · ${totals?.kept ?? 0} kept · ${totals?.dropped ?? 0} dropped`,
  ];
  if (config.scoring.enabled) {
    const spent = await spentOn(db, dayIn(now, config.user.timezone));
    lines.push(`LLM today: ${money(spent)} of ${money(config.scoring.daily_budget_usd)}`);
  }
  lines.push('');
  if (picks.length === 0) {
    lines.push('No new matching jobs waiting for you.');
  } else {
    lines.push(`<b>Top picks</b> (${picks.length} of ${waiting.length} waiting)`);
    for (const row of picks) lines.push(`• ${jobLine(row.job, scoreBadge(row.score))}`);
  }
  if (failing.length > 0) {
    lines.push('', '<b>Failing sources</b>');
    for (const state of failing) {
      const error = escapeHtml(truncate(state.lastError ?? '', 100));
      lines.push(`❌ ${escapeHtml(state.sourceId)}: ${error} (${state.consecutiveFailures}×)`);
    }
  }
  return lines.join('\n');
}

/** Counts over all time and the last 7 days, drop reasons and reject reasons. */
export async function buildStats(db: Db, now: Date): Promise<string> {
  const week = new Date(now.getTime() - 7 * DAY_MS);
  const totalsSince = async (since: Date | null) => {
    const [row] = await db
      .select({
        found: count(),
        kept: sql<number>`count(*) filter (where ${jobs.verdict} <> 'drop')`.mapWith(Number),
        dropped: sql<number>`count(*) filter (where ${jobs.verdict} = 'drop')`.mapWith(Number),
        tracked: sql<number>`count(*) filter (where ${jobs.state} = 'tracked')`.mapWith(Number),
        rejected: sql<number>`count(*) filter (where ${jobs.state} = 'rejected')`.mapWith(Number),
        closed: sql<number>`count(*) filter (where ${jobs.state} = 'closed')`.mapWith(Number),
      })
      .from(jobs)
      .where(since ? gte(jobs.createdAt, since) : undefined);
    return row!;
  };
  const [all, recent] = await Promise.all([totalsSince(null), totalsSince(week)]);

  const primaryReason = sql<string>`${jobs.dropReasons}->>0`;
  const reasons = await db
    .select({ reason: primaryReason, total: count() })
    .from(jobs)
    .where(eq(jobs.verdict, 'drop'))
    .groupBy(primaryReason)
    .orderBy(desc(count()))
    .limit(10);

  const rejects = await db
    .select({ reason: feedback.reason, total: count() })
    .from(feedback)
    .where(eq(feedback.action, 'reject'))
    .groupBy(feedback.reason)
    .orderBy(desc(count()))
    .limit(10);

  const [trackerRows] = await db.select({ total: count() }).from(trackerEntries);

  const row = (label: string, key: keyof typeof all) =>
    `${label.padEnd(9)}${String(recent[key]).padStart(7)}${String(all[key]).padStart(9)}`;
  const table = [
    `${''.padEnd(9)}${'7 days'.padStart(7)}${'all'.padStart(9)}`,
    row('Found', 'found'),
    row('Kept', 'kept'),
    row('Dropped', 'dropped'),
    row('Tracked', 'tracked'),
    row('Rejected', 'rejected'),
    row('Closed', 'closed'),
  ].join('\n');

  const lines = ['<b>Stats</b>', `<pre>${table}</pre>`];
  if (reasons.length > 0) {
    lines.push('<b>Main drop reasons</b>');
    for (const entry of reasons) {
      lines.push(`${entry.total} · ${escapeHtml(describeReason(entry.reason ?? 'unknown'))}`);
    }
  }
  if (rejects.length > 0) {
    lines.push('', '<b>Your reject reasons</b>');
    for (const entry of rejects)
      lines.push(`${entry.total} · ${escapeHtml(entry.reason ?? 'none')}`);
  }
  lines.push('', `Tracker rows: ${trackerRows?.total ?? 0}`);
  return lines.join('\n');
}

const STATE_ICON: Readonly<Record<string, string>> = {
  new: '🆕',
  tracked: '✅',
  rejected: '❌',
  closed: '⛔',
};

/** Stored jobs whose title, company or description contain every word of the query. */
export async function searchJobs(db: Db, query: string, limit = 10): Promise<string> {
  const words = query
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .slice(0, 6);
  if (words.length === 0) return 'Usage: /search &lt;words&gt;, e.g. /search react remote';

  const like = (word: string) => `%${word.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const conditions = words.map((word) =>
    or(
      ilike(jobs.title, like(word)),
      ilike(jobs.company, like(word)),
      ilike(jobs.description, like(word)),
    ),
  );
  const rows = await db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
  if (rows.length === 0) return `Nothing found for “${escapeHtml(query)}”.`;

  const scores = await db
    .select()
    .from(llmScores)
    .where(
      inArray(
        llmScores.jobId,
        rows.map((job) => job.id),
      ),
    );
  const byJob = new Map(scores.map((score) => [score.jobId, score]));
  const inHeadline = new RegExp(words.map(escapeRegex).join('|'), 'i');

  const more = rows.length === limit ? '+' : '';
  const lines = [`<b>Search:</b> ${escapeHtml(query)} (${rows.length}${more})`];
  for (const job of rows) {
    const icon = job.verdict === 'drop' ? '🚫' : (STATE_ICON[job.state] ?? '•');
    const where = inHeadline.test(`${job.title} ${job.company ?? ''}`) ? '' : ' (in description)';
    lines.push(`${icon} ${jobLine(job, scoreBadge(byJob.get(job.id)))}${where}`);
  }
  lines.push('', '🆕 new · ✅ tracked · ❌ rejected · ⛔ closed · 🚫 filtered out');
  return lines.join('\n');
}

/** "HH:MM" in the given zone. */
export function localTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
