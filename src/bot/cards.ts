import { InlineKeyboard } from 'grammy';
import type { Config } from '../config/schema.js';
import type { ApplicationDraftRow, JobLinkRow, JobRow, LlmScoreRow } from '../db/schema.js';
import { FLAGS } from '../filters/types.js';
import type { Salary, SalaryPeriod } from '../normalize/job.js';
import { formatSalary } from '../normalize/salary.js';
import { truncate } from '../util/text.js';

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const EMPLOYMENT_LABEL: Readonly<Record<string, string>> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  internship: 'Internship',
};

const WORK_MODE_LABEL: Readonly<Record<string, string>> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
  onsite: 'On-site',
};

export function salaryOfRow(job: JobRow): Salary | null {
  if (job.salaryMin === null && job.salaryMax === null) return null;
  return {
    min: job.salaryMin,
    max: job.salaryMax,
    currency: job.salaryCurrency,
    period: job.salaryPeriod as SalaryPeriod | null,
    periodInferred: false,
    text: job.salaryText ?? '',
  };
}

export function locationLine(job: JobRow): string {
  const mode = job.workMode ? WORK_MODE_LABEL[job.workMode] : undefined;
  const text = job.locationText?.trim();
  if (mode && text && !text.toLowerCase().includes(mode.toLowerCase())) return `${mode} · ${text}`;
  return text || mode || 'Location not stated';
}

export function formatDate(date: Date, timeZone: string, withTime = false): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
  }).format(date);
}

/** Display name of a link: the board or feed it came from. */
/** Board names as their terms ask to be credited. */
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  remoteok: 'Remote OK',
  remotive: 'Remotive',
  jobicy: 'Jobicy',
  himalayas: 'Himalayas',
};

const linkLabel = (link: Pick<JobLinkRow, 'sourceType' | 'sourceId'>): string =>
  link.sourceType === 'rss'
    ? link.sourceId.replace(/^rss:/, '')
    : (SOURCE_NAMES[link.sourceType] ?? link.sourceType);

export interface CardData {
  job: JobRow;
  links: readonly JobLinkRow[];
  score?: LlmScoreRow | null;
}

/** "P1 · 82/100" */
export function scoreBadge(score: LlmScoreRow | null | undefined): string | null {
  if (!score) return null;
  const parts = [score.priority, score.fitScore !== null ? `${score.fitScore}/100` : null];
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

/** Card body in Telegram HTML. `status` is appended once the user has acted on the job. */
export function renderCard(
  { job, links, score }: CardData,
  config: Config,
  status?: string,
): string {
  const lines: string[] = [`<b>${escapeHtml(truncate(job.title, 200))}</b>`];
  if (job.company) lines.push(escapeHtml(truncate(job.company, 100)));
  lines.push('');

  const badge = scoreBadge(score);
  if (score && badge) {
    lines.push(
      `🎯 <b>${escapeHtml(badge)}</b>${score.reason ? ` · ${escapeHtml(score.reason)}` : ''}`,
    );
    for (const flag of score.redFlags) {
      lines.push(`🚩 ${escapeHtml(flag.kind)}: ${escapeHtml(flag.note)}`);
    }
    if (score.stack.length > 0) lines.push(`🧰 ${escapeHtml(score.stack.join(', '))}`);
  }

  lines.push(`💰 ${escapeHtml(formatSalary(salaryOfRow(job)) ?? 'Pay not stated')}`);
  lines.push(`📍 ${escapeHtml(truncate(locationLine(job), 200))}`);

  const facts: string[] = [];
  if (job.employmentType) facts.push(EMPLOYMENT_LABEL[job.employmentType] ?? job.employmentType);
  facts.push(
    job.postedAt
      ? `posted ${formatDate(job.postedAt, config.user.timezone)}`
      : `found ${formatDate(job.firstSeenAt, config.user.timezone)}`,
  );
  lines.push(`🗓 ${escapeHtml(facts.join(' · '))}`);

  const remarks = job.flags
    .filter((code) => code !== 'pay_unstated' && code !== 'location_unstated')
    .map((code) => (FLAGS as Record<string, string>)[code] ?? code);
  if (remarks.length > 0) lines.push(`⚠️ ${escapeHtml(remarks.join('; '))}`);

  const ordered = [...links].sort(
    (a, b) => Number(b.url === job.primaryUrl) - Number(a.url === job.primaryUrl),
  );
  const seen = new Set<string>();
  const anchors = ordered
    .filter((link) => !seen.has(link.canonicalUrl) && seen.add(link.canonicalUrl))
    .slice(0, 5)
    .map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(linkLabel(link))}</a>`);
  if (anchors.length === 0) {
    anchors.push(
      `<a href="${escapeHtml(job.primaryUrl)}">${escapeHtml(job.primarySourceType)}</a>`,
    );
  }
  lines.push(`🔗 ${anchors.join(' · ')}`);

  if (status) lines.push('', status);
  return lines.join('\n');
}

/* Callback data stays far below Telegram's 64-byte limit: an action code and the job id. */
export const CALLBACK = {
  track: (jobId: number) => `t:${jobId}`,
  trackAnyway: (jobId: number) => `ta:${jobId}`,
  reject: (jobId: number) => `r:${jobId}`,
  rejectReason: (jobId: number, index: number) => `rr:${jobId}:${index}`,
  snooze: (jobId: number) => `s:${jobId}`,
  snoozeFor: (jobId: number, hours: number) => `ss:${jobId}:${hours}`,
  back: (jobId: number) => `b:${jobId}`,
  prepare: (jobId: number) => `p:${jobId}`,
} as const;

export interface KeyboardOptions {
  /** Show "Prepare application" (when drafting is configured). */
  prepare?: boolean;
}

export function mainKeyboard(jobId: number, options: KeyboardOptions = {}): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('✅ Add to tracker', CALLBACK.track(jobId))
    .text('❌ Reject', CALLBACK.reject(jobId))
    .row()
    .text('💤 Later', CALLBACK.snooze(jobId));
  if (options.prepare) keyboard.text('📝 Prepare application', CALLBACK.prepare(jobId));
  return keyboard;
}

/** Left on a card after it is tracked, so an application can still be drafted. */
export function prepareKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard().text('📝 Prepare application', CALLBACK.prepare(jobId));
}

export function rejectKeyboard(jobId: number, reasons: readonly string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  reasons.forEach((reason, index) => {
    keyboard.text(reason, CALLBACK.rejectReason(jobId, index));
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard.row().text('« Back', CALLBACK.back(jobId));
}

const hoursLabel = (hours: number): string => (hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`);

export function snoozeKeyboard(jobId: number, hours: readonly number[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const value of hours) keyboard.text(hoursLabel(value), CALLBACK.snoozeFor(jobId, value));
  return keyboard.row().text('« Back', CALLBACK.back(jobId));
}

export function unknownLivenessKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Add anyway', CALLBACK.trackAnyway(jobId))
    .text('« Back', CALLBACK.back(jobId));
}

const TELEGRAM_LIMIT = 4096;

/**
 * One message listing many jobs, used when more than `batch_threshold` are waiting.
 * Each line ends with a /job_<id> command that opens the full card with its buttons.
 * Returns several messages when the list does not fit into one.
 */
export function renderDigest(
  jobs: readonly JobRow[],
  title: string,
  scores: ReadonlyMap<number, LlmScoreRow> = new Map(),
  priorityOrder: readonly string[] = [],
): string[] {
  const rank = (job: JobRow): [number, number] => {
    const score = scores.get(job.id);
    const index = score?.priority ? priorityOrder.indexOf(score.priority) : -1;
    return [index === -1 ? priorityOrder.length : index, -(score?.fitScore ?? -1)];
  };
  const ordered = [...jobs].sort((a, b) => {
    const [pa, sa] = rank(a);
    const [pb, sb] = rank(b);
    return pa - pb || sa - sb;
  });

  const messages: string[] = [];
  let current = `<b>${escapeHtml(title)}</b>\n`;

  ordered.forEach((job, index) => {
    const badge = scoreBadge(scores.get(job.id));
    const parts = [badge, job.company, formatSalary(salaryOfRow(job)), locationLine(job)]
      .filter((part): part is string => Boolean(part))
      .map((part) => escapeHtml(truncate(part, 60)));
    const line = `\n${index + 1}. <b>${escapeHtml(truncate(job.title, 90))}</b>\n${parts.join(' · ')}\n/job_${job.id}\n`;
    if (current.length + line.length > TELEGRAM_LIMIT) {
      messages.push(current);
      current = '';
    }
    current += line;
  });
  messages.push(current);
  return messages;
}

/**
 * An application draft as Telegram messages. Every answer sits in its own <pre> block, which
 * Telegram copies with one tap.
 */
export function renderDraft(job: JobRow, draft: ApplicationDraftRow): string[] {
  const head = [
    `📝 <b>Application draft</b>: ${escapeHtml(truncate(job.title, 120))}${job.company ? ` at ${escapeHtml(truncate(job.company, 80))}` : ''}`,
    'Built only from your profile. Read every answer before you paste it; ✏️ marks what you must fill in yourself.',
  ].join('\n');

  const blocks: string[] = [head];
  if (draft.coverLetter) {
    blocks.push(`<b>Cover letter</b>\n<pre>${escapeHtml(draft.coverLetter)}</pre>`);
  }
  draft.answers.forEach((answer, index) => {
    const label = `<b>${index + 1}. ${escapeHtml(truncate(answer.question, 300))}</b>${answer.required ? ' (required)' : ''}`;
    if (answer.needsInput) {
      const partial = answer.answer ? `\n<pre>${escapeHtml(answer.answer)}</pre>` : '';
      blocks.push(
        `${label}${partial}\n✏️ ${escapeHtml(answer.note || 'Your profile does not cover this.')}`,
      );
    } else {
      blocks.push(`${label}\n<pre>${escapeHtml(answer.answer)}</pre>`);
    }
  });
  if (draft.skipped.length > 0) {
    blocks.push(`<i>Fill in yourself: ${escapeHtml(truncate(draft.skipped.join('; '), 600))}</i>`);
  }

  const messages: string[] = [];
  let current = '';
  for (const block of blocks) {
    const piece =
      block.length > TELEGRAM_LIMIT - 10 ? `${block.slice(0, TELEGRAM_LIMIT - 20)}</pre>` : block;
    if (current && current.length + piece.length + 2 > TELEGRAM_LIMIT) {
      messages.push(current);
      current = '';
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) messages.push(current);
  return messages;
}
