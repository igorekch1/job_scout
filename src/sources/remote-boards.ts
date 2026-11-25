import { z } from 'zod';
import type { EmploymentType, RawJob, Salary, SalaryPeriod } from '../normalize/job.js';
import { matchesAny } from './keywords.js';
import { parseDate, type FetchContext, type Source } from './types.js';

const employmentFrom = (value: string | null | undefined): EmploymentType | null => {
  if (!value) return null;
  if (/intern/i.test(value)) return 'internship';
  if (/part[\s_-]?time/i.test(value)) return 'part_time';
  if (/contract|freelance|temporary/i.test(value)) return 'contract';
  if (/full[\s_-]?time/i.test(value)) return 'full_time';
  return null;
};

const salaryFrom = (
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string | null | undefined,
  period: SalaryPeriod | null,
  text: string,
): Salary | null => {
  const low = typeof min === 'number' && min > 0 ? min : null;
  const high = typeof max === 'number' && max > 0 ? max : null;
  if (low === null && high === null) return null;
  return {
    min: low,
    max: high,
    currency: currency?.toUpperCase() ?? 'USD',
    period,
    periodInferred: period === null,
    text,
  };
};

/* ------------------------------------------------------------------- Remotive */

const remotiveJob = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  company_name: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  job_type: z.string().nullish(),
  publication_date: z.string().nullish(),
  candidate_required_location: z.string().nullish(),
  salary: z.string().nullish(),
  description: z.string().nullish(),
});

export function mapRemotiveJob(input: unknown): RawJob | null {
  const parsed = remotiveJob.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  // timestamps come without a zone and are UTC
  const published = job.publication_date
    ? parseDate(
        /[zZ]|[+-]\d{2}:?\d{2}$/.test(job.publication_date)
          ? job.publication_date
          : `${job.publication_date}Z`,
      )
    : null;
  return {
    externalId: String(job.id),
    url: job.url,
    title: job.title,
    company: job.company_name ?? null,
    descriptionHtml: job.description ?? null,
    locationText: job.candidate_required_location?.trim() || null,
    workMode: 'remote',
    salaryText: job.salary?.trim() || null,
    employmentType: employmentFrom(job.job_type),
    postedAt: published,
    raw: input,
  };
}

export const remotiveUrl = (category?: string): string =>
  `https://remotive.com/api/remote-jobs${category ? `?category=${encodeURIComponent(category)}` : ''}`;

export function createRemotiveSource(
  settings: { category?: string; search: readonly string[] },
  intervalMinutes: number,
): Source {
  return {
    id: `remotive:${settings.category ?? 'all'}`,
    type: 'remotive',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getJson<{ jobs?: unknown[] }>(remotiveUrl(settings.category));
      if (result.notModified) return [];
      if (!Array.isArray(result.data?.jobs))
        throw new Error('Remotive returned an unexpected response');
      return result.data.jobs.flatMap((entry) => {
        const job = mapRemotiveJob(entry);
        const tags = (entry as { tags?: string[] }).tags ?? [];
        return job && matchesAny(settings.search, job.title, tags.join(' '), job.descriptionHtml)
          ? [job]
          : [];
      });
    },
  };
}

/* ------------------------------------------------------------------- RemoteOK */

const remoteOkJob = z.object({
  id: z.union([z.string(), z.number()]),
  url: z.string(),
  position: z.string(),
  company: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  salary_min: z.number().nullish(),
  salary_max: z.number().nullish(),
  date: z.string().nullish(),
  epoch: z.number().nullish(),
});

export function mapRemoteOkJob(input: unknown): RawJob | null {
  const parsed = remoteOkJob.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  return {
    externalId: String(job.id),
    url: job.url,
    title: job.position,
    company: job.company ?? null,
    descriptionHtml: job.description ?? null,
    locationText: job.location?.trim() || null,
    workMode: 'remote',
    // RemoteOK states yearly USD figures
    salary: salaryFrom(job.salary_min, job.salary_max, 'USD', 'year', 'Remote OK salary'),
    postedAt:
      parseDate(job.date) ?? (typeof job.epoch === 'number' ? new Date(job.epoch * 1000) : null),
    raw: input,
  };
}

export const remoteOkUrl = (tag?: string): string =>
  tag ? `https://remoteok.com/api?tag=${encodeURIComponent(tag)}` : 'https://remoteok.com/api';

/**
 * One request per tag: RemoteOK filters by tag on its side, while the unfiltered feed holds only
 * the latest 100 jobs of every category.
 */
export function createRemoteOkSource(
  settings: { tags: readonly string[] },
  intervalMinutes: number,
): Source {
  return {
    id: 'remoteok',
    type: 'remoteok',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const urls = settings.tags.length > 0 ? settings.tags.map(remoteOkUrl) : [remoteOkUrl()];
      const jobs = new Map<string, RawJob>();
      for (const url of urls) {
        const result = await http.getJson<unknown[]>(url);
        if (result.notModified) continue;
        if (!Array.isArray(result.data))
          throw new Error('Remote OK returned an unexpected response');
        // the first element is the legal notice, not a job
        for (const entry of result.data) {
          const job = mapRemoteOkJob(entry);
          if (job) jobs.set(job.externalId, job);
        }
      }
      return [...jobs.values()];
    },
  };
}

/* --------------------------------------------------------------------- Jobicy */

const jobicyJob = z.object({
  id: z.number(),
  url: z.string(),
  jobTitle: z.string(),
  companyName: z.string().nullish(),
  jobIndustry: z.array(z.string()).nullish(),
  jobType: z.array(z.string()).nullish(),
  jobGeo: z.string().nullish(),
  jobDescription: z.string().nullish(),
  pubDate: z.string().nullish(),
  annualSalaryMin: z.union([z.number(), z.string()]).nullish(),
  annualSalaryMax: z.union([z.number(), z.string()]).nullish(),
  salaryCurrency: z.string().nullish(),
});

const toNumber = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function mapJobicyJob(input: unknown): RawJob | null {
  const parsed = jobicyJob.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  return {
    externalId: String(job.id),
    url: job.url,
    title: job.jobTitle,
    company: job.companyName ?? null,
    descriptionHtml: job.jobDescription ?? null,
    locationText: job.jobGeo?.trim() || null,
    workMode: 'remote',
    salary: salaryFrom(
      toNumber(job.annualSalaryMin),
      toNumber(job.annualSalaryMax),
      job.salaryCurrency,
      'year',
      'Jobicy salary',
    ),
    employmentType: employmentFrom(job.jobType?.[0]),
    postedAt: parseDate(job.pubDate),
    raw: input,
  };
}

export function jobicyUrl(settings: { geo?: string; industry?: string }): string {
  const params = new URLSearchParams({ count: '100' });
  if (settings.geo) params.set('geo', settings.geo);
  if (settings.industry) params.set('industry', settings.industry);
  return `https://jobicy.com/api/jobs?${params.toString()}`;
}

export function createJobicySource(
  settings: { tags: readonly string[]; geo?: string; industry?: string },
  intervalMinutes: number,
): Source {
  return {
    id: 'jobicy',
    type: 'jobicy',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getJson<{ jobs?: unknown[] }>(jobicyUrl(settings));
      if (result.notModified) return [];
      if (!Array.isArray(result.data?.jobs))
        throw new Error('Jobicy returned an unexpected response');
      return result.data.jobs.flatMap((entry) => {
        const job = mapJobicyJob(entry);
        const industry = ((entry as { jobIndustry?: string[] }).jobIndustry ?? []).join(' ');
        return job && matchesAny(settings.tags, job.title, industry, job.descriptionHtml)
          ? [job]
          : [];
      });
    },
  };
}

/* ------------------------------------------------------------------ Himalayas */

const himalayasJob = z.object({
  guid: z.string(),
  title: z.string(),
  companyName: z.string().nullish(),
  employmentType: z.string().nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  currency: z.string().nullish(),
  salaryPeriod: z.string().nullish(),
  locationRestrictions: z.array(z.string()).nullish(),
  description: z.string().nullish(),
  pubDate: z.number().nullish(),
  applicationLink: z.string().nullish(),
});

const HIMALAYAS_PERIOD: Readonly<Record<string, SalaryPeriod>> = {
  annual: 'year',
  yearly: 'year',
  monthly: 'month',
  weekly: 'week',
  daily: 'day',
  hourly: 'hour',
};

export function mapHimalayasJob(input: unknown): RawJob | null {
  const parsed = himalayasJob.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  const restrictions = (job.locationRestrictions ?? []).filter(Boolean);
  return {
    externalId: job.guid,
    // the Himalayas page, as its terms require; it carries the unchanged application link
    url: job.guid,
    title: job.title,
    company: job.companyName ?? null,
    descriptionHtml: job.description ?? null,
    // no restriction list means the job is open worldwide
    locationText: restrictions.length > 0 ? restrictions.join('; ') : 'Worldwide',
    workMode: 'remote',
    salary: salaryFrom(
      job.minSalary,
      job.maxSalary,
      job.currency,
      HIMALAYAS_PERIOD[job.salaryPeriod?.toLowerCase() ?? ''] ?? null,
      'Himalayas salary',
    ),
    employmentType: employmentFrom(job.employmentType),
    postedAt: typeof job.pubDate === 'number' ? new Date(job.pubDate * 1000) : null,
    raw: input,
  };
}

export const himalayasUrl = (query?: string): string =>
  query
    ? `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(query)}&sort=recent`
    : 'https://himalayas.app/jobs/api?limit=20';

export function createHimalayasSource(
  settings: { queries: readonly string[] },
  intervalMinutes: number,
): Source {
  return {
    id: 'himalayas',
    type: 'himalayas',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const urls =
        settings.queries.length > 0 ? settings.queries.map(himalayasUrl) : [himalayasUrl()];
      const jobs: RawJob[] = [];
      for (const url of urls) {
        const result = await http.getJson<{ jobs?: unknown[] }>(url);
        if (result.notModified) continue;
        if (!Array.isArray(result.data?.jobs))
          throw new Error('Himalayas returned an unexpected response');
        jobs.push(...result.data.jobs.flatMap((entry) => mapHimalayasJob(entry) ?? []));
      }
      return jobs;
    },
  };
}
