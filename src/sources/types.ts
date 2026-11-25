import type { SourceHttp } from '../http/session.js';
import type { RawJob } from '../normalize/job.js';

export interface FetchContext {
  /** When this source last completed successfully, or null on its first run. */
  since: Date | null;
  http: SourceHttp;
}

/**
 * A place jobs come from. To add one: implement this interface, register it in
 * `registry.ts` and add its settings to the config schema. See docs/adding-a-source.md.
 */
export interface Source {
  /** Unique instance id, e.g. "greenhouse:acme" or "rss:my-feed". Shown in /status. */
  id: string;
  /** Source type, e.g. "greenhouse". Used for the primary-link priority. */
  type: string;
  intervalMinutes: number;
  /**
   * Returns the postings currently visible at the source. Returning postings that were
   * seen before is fine: the pipeline deduplicates. Throw on failure.
   */
  fetch(context: FetchContext): Promise<RawJob[]>;
}

/** "example-company" -> "Example Company", for boards whose API does not name the employer. */
export function companyFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
