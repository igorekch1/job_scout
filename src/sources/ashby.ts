import { z } from 'zod';
import type { EmploymentType, RawJob, Salary, SalaryPeriod, WorkMode } from '../normalize/job.js';
import { parseSalary } from '../normalize/salary.js';
import { companyFromSlug, parseDate, type FetchContext, type Source } from './types.js';

const componentSchema = z.object({
  compensationType: z.string().nullish(),
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});

const jobSchema = z.object({
  id: z.string(),
  title: z.string(),
  jobUrl: z.string(),
  applyUrl: z.string().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.object({ location: z.string().nullish() })).nullish(),
  employmentType: z.string().nullish(),
  workplaceType: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  compensation: z
    .object({
      compensationTierSummary: z.string().nullish(),
      scrapeableCompensationSalarySummary: z.string().nullish(),
      summaryComponents: z.array(componentSchema).nullish(),
    })
    .nullish(),
});

const responseSchema = z.object({ jobs: z.array(z.unknown()) });

export type AshbyJob = z.infer<typeof jobSchema>;

const EMPLOYMENT: Readonly<Record<string, EmploymentType>> = {
  fulltime: 'full_time',
  parttime: 'part_time',
  contract: 'contract',
  temporary: 'contract',
  intern: 'internship',
};

const WORKPLACE: Readonly<Record<string, WorkMode>> = {
  remote: 'remote',
  hybrid: 'hybrid',
  onsite: 'onsite',
};

const INTERVALS: Readonly<Record<string, SalaryPeriod>> = {
  '1 HOUR': 'hour',
  '1 DAY': 'day',
  '1 WEEK': 'week',
  '1 MONTH': 'month',
  '1 YEAR': 'year',
};

function salaryOf(job: AshbyJob): Salary | null {
  const compensation = job.compensation;
  if (!compensation) return null;
  const summary =
    compensation.scrapeableCompensationSalarySummary ?? compensation.compensationTierSummary ?? '';

  const component = compensation.summaryComponents?.find(
    (entry) =>
      entry.compensationType === 'Salary' &&
      (typeof entry.minValue === 'number' || typeof entry.maxValue === 'number'),
  );
  if (component) {
    return {
      min: component.minValue ?? null,
      max: component.maxValue ?? null,
      currency: component.currencyCode?.toUpperCase() ?? null,
      period: INTERVALS[component.interval ?? ''] ?? null,
      periodInferred: false,
      text: summary || 'salary',
    };
  }
  return parseSalary(summary);
}

/** Maps one Ashby posting. Returns null for unlisted or malformed entries. */
export function mapAshbyJob(input: unknown, board: string): RawJob | null {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  if (job.isListed === false) return null;

  const locations = [job.location, ...(job.secondaryLocations ?? []).map((entry) => entry.location)]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.trim());
  const workMode =
    WORKPLACE[job.workplaceType?.toLowerCase() ?? ''] ?? (job.isRemote === true ? 'remote' : null);

  return {
    externalId: job.id,
    url: job.jobUrl,
    title: job.title,
    company: companyFromSlug(board),
    descriptionHtml: job.descriptionHtml ?? null,
    descriptionText: job.descriptionPlain ?? null,
    locationText: locations.length > 0 ? [...new Set(locations)].join('; ') : null,
    workMode,
    salary: salaryOf(job),
    employmentType: EMPLOYMENT[job.employmentType?.toLowerCase() ?? ''] ?? null,
    postedAt: parseDate(job.publishedAt),
    raw: input,
  };
}

export const ashbyBoardUrl = (board: string): string =>
  `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;

export function createAshbySource(board: string, intervalMinutes: number): Source {
  return {
    id: `ashby:${board}`,
    type: 'ashby',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getJson(ashbyBoardUrl(board));
      if (result.notModified) return [];
      const response = responseSchema.safeParse(result.data);
      if (!response.success) {
        throw new Error(`Ashby board "${board}" returned an unexpected response`);
      }
      return response.data.jobs.flatMap((entry) => mapAshbyJob(entry, board) ?? []);
    },
  };
}
