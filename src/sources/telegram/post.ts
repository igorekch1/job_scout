import type { RawJob } from '../../normalize/job.js';

/** One channel post, as the reader returns it. */
export interface ChannelPost {
  id: number;
  date: Date;
  text: string;
  /** URLs from link entities and the text, in order. */
  links: string[];
}

const JOB_WORDS =
  /\b(vacanc|hiring|we are looking|we're looking|position|role|developer|engineer|frontend|front-end|backend|full[- ]?stack|lead|вакансі|ваканси|шукаємо|ищем|розробник|разработчик|інженер|инженер)/iu;

const TELEGRAM_HOSTS = /^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\//i;

const URL_IN_TEXT = /https?:\/\/[^\s<>()"'«»]+[^\s<>()"'«».,;:!?]/giu;

/** Removes emoji, markdown markers and stray symbols around a line. */
function cleanLine(line: string): string {
  return line
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[*_`~|]+/g, '')
    .replace(/^[\s\-–—•·:>]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const LABELED = (labels: string) => new RegExp(`^(?:${labels})\\s*[:：-]\\s*(.+)$`, 'iu');

const COMPANY_LINE = LABELED('company|employer|компанія|компания|роботодавець|работодатель');
const TITLE_LINE = LABELED(
  'position|role|title|vacancy|job|позиція|позиция|посада|вакансія|вакансия|должность',
);
const LOCATION_LINE = LABELED(
  'location|locations|локація|локация|місто|город|формат|format|work format|формат роботи|формат работы',
);
const SALARY_LINE = LABELED(
  'salary|compensation|rate|budget|зарплата|зп|з/п|ставка|оплата|компенсація|компенсация',
);

/** "Senior React Developer at Acme" or "Senior React Developer в Acme" */
const AT_COMPANY = /^(.{6,120}?)\s+(?:at|@|в|у)\s+([\p{Lu}0-9][^,.!?]{1,60})$/u;

const isHashtagLine = (line: string): boolean => /^(#[\p{L}\p{N}_]+\s*)+$/u.test(line);

export function extractLinks(text: string, entityLinks: readonly string[] = []): string[] {
  const found = [...entityLinks, ...(text.match(URL_IN_TEXT) ?? [])];
  return [...new Set(found.map((url) => url.trim()))];
}

/**
 * Reads a free-text channel post into a raw job. Returns null for posts that do not look like
 * a single job posting (news, ads, very short messages).
 */
export function parsePost(post: ChannelPost, channel: string): RawJob | null {
  const text = post.text.trim();
  if (text.length < 60 || !JOB_WORDS.test(text)) return null;

  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line.length > 0 && !isHashtagLine(line));
  if (lines.length === 0) return null;

  let title: string | undefined;
  let company: string | null = null;
  let location: string | null = null;
  let salary: string | null = null;

  for (const line of lines) {
    title ??= TITLE_LINE.exec(line)?.[1];
    company ??= COMPANY_LINE.exec(line)?.[1]?.trim() ?? null;
    location ??= LOCATION_LINE.exec(line)?.[1]?.trim() ?? null;
    salary ??= SALARY_LINE.exec(line)?.[1]?.trim() ?? null;
  }

  if (!title) {
    // the first line that names a role, else the first line
    const first = lines.find((line) => JOB_WORDS.test(line) && line.length <= 160) ?? lines[0]!;
    const atCompany = AT_COMPANY.exec(first);
    if (atCompany) {
      title = atCompany[1]!;
      company ??= atCompany[2]!.trim();
    } else {
      title = first;
    }
  }
  title = title.replace(/^(?:#?(?:vacancy|вакансія|вакансия|hiring))\s*[:\-–—]?\s*/iu, '').trim();
  if (title.length < 3) return null;
  if (title.length > 140) title = `${title.slice(0, 139).trimEnd()}…`;

  const external = post.links.find((link) => !TELEGRAM_HOSTS.test(link));
  const postUrl = `https://t.me/${channel}/${post.id}`;

  return {
    externalId: `${channel}/${post.id}`,
    url: external ?? postUrl,
    title,
    company,
    descriptionText: `${text}\n\nSource post: ${postUrl}`,
    locationText: location,
    salaryText: salary,
    postedAt: post.date,
    raw: { channel, id: post.id, date: post.date.toISOString(), links: post.links },
  };
}
