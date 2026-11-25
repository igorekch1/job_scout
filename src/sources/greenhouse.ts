import { z } from 'zod';
import type { RawJob, Salary } from '../normalize/job.js';
import { companyFromSlug, parseDate, type FetchContext, type Source } from './types.js';

const payRangeSchema = z.object({
  min_cents: z.number().nullish(),
  max_cents: z.number().nullish(),
  currency_type: z.string().nullish(),
  title: z.string().nullish(),
});

const jobSchema = z.object({
  id: z.number(),
  title: z.string(),
  absolute_url: z.string(),
  company_name: z.string().nullish(),
  content: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  pay_input_ranges: z.array(payRangeSchema).nullish(),
});

const responseSchema = z.object({ jobs: z.array(z.unknown()) });

export type GreenhouseJob = z.infer<typeof jobSchema>;

function salaryOf(job: GreenhouseJob): Salary | null {
  const range = job.pay_input_ranges?.find(
    (entry) => typeof entry.min_cents === 'number' || typeof entry.max_cents === 'number',
  );
  if (!range) return null;
  const min = typeof range.min_cents === 'number' ? range.min_cents / 100 : null;
  const max = typeof range.max_cents === 'number' ? range.max_cents / 100 : null;
  const top = max ?? min ?? 0;
  return {
    min,
    max,
    currency: range.currency_type?.toUpperCase() ?? null,
    // Greenhouse does not state the period; hourly ranges are well under this bound
    period: top >= 1000 ? 'year' : 'hour',
    periodInferred: true,
    text: range.title ?? 'pay range',
  };
}

/** Maps one Greenhouse posting. Returns null for entries that do not look like a posting. */
export function mapGreenhouseJob(input: unknown, board: string): RawJob | null {
  const parsed = jobSchema.safeParse(input);
  if (!parsed.success) return null;
  const job = parsed.data;
  return {
    externalId: String(job.id),
    url: job.absolute_url,
    title: job.title,
    company: job.company_name?.trim() || companyFromSlug(board),
    descriptionHtml: job.content ?? null,
    locationText: job.location?.name ?? null,
    salary: salaryOf(job),
    postedAt: parseDate(job.first_published) ?? parseDate(job.updated_at),
    raw: input,
  };
}

export const greenhouseBoardUrl = (board: string): string =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true&pay_transparency=true`;

export const greenhouseJobUrl = (board: string, jobId: string): string =>
  `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`;

export function createGreenhouseSource(board: string, intervalMinutes: number): Source {
  return {
    id: `greenhouse:${board}`,
    type: 'greenhouse',
    intervalMinutes,
    async fetch({ http }: FetchContext): Promise<RawJob[]> {
      const result = await http.getJson(greenhouseBoardUrl(board));
      if (result.notModified) return [];
      const response = responseSchema.safeParse(result.data);
      if (!response.success) {
        throw new Error(`Greenhouse board "${board}" returned an unexpected response`);
      }
      return response.data.jobs.flatMap((entry) => mapGreenhouseJob(entry, board) ?? []);
    },
  };
}
