import { z } from 'zod';
import type { EmploymentType, RawJob, Salary, SalaryPeriod, WorkMode } from '../normalize/job.js';
import { companyFromSlug, type FetchContext, type Source } from './types.js';

const jobSchema = z.object({
  id: z.string(),
  text: z.string(),
  hostedUrl: z.string(),
  createdAt: z.number().nullish(),
  categories: z
    .object({
      commitment: z.string().nullish(),
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  country: z.string().nullish(),
  workplaceType: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  description: z.string().nullish(),
  lists: z.array(z.object({ text: z.string().nullish(), content: z.string().nullish() })).nullish(),
  additional: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      interval: z.string().nullish(),
    })
    .nullish(),
});

const INTERVALS: Readonly<Record<string, SalaryPeriod>> = {
  'per-year-salary': 'year',
  'per-month-salary': 'month',
  'per-week-salary': 'week',
  'per-day-wage': 'day',
  'per-hour-wage': 'hour',
};

const WORKPLACE: Readonly<Record<string, WorkMode>> = {
  remote: 'remote',
  hybrid: 'hybrid',
  'on-site': 'onsite',
  onsite: 'onsite',
};

function employment(commitment: string | null | undefined): EmploymentType | null {
  if (!commitment) return null;
  if (/intern/i.test(commitment)) return 'internship';
  if (/part[- ]time/i.test(commitment)) return 'part_time';
  if (/contract|freelance|temporary/i.test(commitment)) return 'contract';
  if (/full[- ]time|permanent|regular/i.test(commitment)) return 'full_time';
  return null;
}

/** Maps one Lever posting. Returns null for entries that do not look like a posting. */
export function mapLeverJob(input: unknown, site: string): RawJob | null {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  const range = job.salaryRange;
  const salary: Salary | null =
    range && (typeof range.min === 'number' || typeof range.max === 'number')
      ? {
          min: range.min ?? null,
          max: range.max ?? null,
          currency: range.currency?.toUpperCase() ?? null,
          period: INTERVALS[range.interval ?? ''] ?? null,
          periodInferred: false,
          text: range.interval ?? 'salary range',
        }
      : null;
  const locations = [
    ...(job.categories?.allLocations ?? []),
    job.categories?.location ?? undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  const lists = (job.lists ?? [])
    .map((list) => `<h3>${list.text ?? ''}</h3><ul>${list.content ?? ''}</ul>`)
    .join('');

  return {
    externalId: job.id,
    url: job.hostedUrl,
    title: job.text,
    company: companyFromSlug(site),
    descriptionHtml: `${job.description ?? ''}${lists}${job.additional ?? ''}`,
    locationText: locations.length > 0 ? [...new Set(locations)].join('; ') : null,
    workMode: WORKPLACE[job.workplaceType?.toLowerCase() ?? ''] ?? null,
    salary,
    employmentType: employment(job.categories?.commitment),
    postedAt: typeof job.createdAt === 'number' ? new Date(job.createdAt) : null,
    raw: input,
  };
}

export const leverApiBase = (eu: boolean): string =>
  eu ? 'https://api.eu.lever.co/v0/postings' : 'https://api.lever.co/v0/postings';

export const leverBoardUrl = (site: string, eu = false): string =>
  `${leverApiBase(eu)}/${encodeURIComponent(site)}?mode=json`;

export function createLeverSource(site: string, intervalMinutes: number, eu = false): Source {
  return {
    id: `lever:${site}`,
    type: 'lever',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getJson(leverBoardUrl(site, eu));
      if (result.notModified) return [];
      if (!Array.isArray(result.data)) {
        throw new Error(`Lever site "${site}" returned an unexpected response`);
      }
      return result.data.flatMap((entry) => mapLeverJob(entry, site) ?? []);
    },
  };
}
