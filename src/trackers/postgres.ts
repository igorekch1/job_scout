import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { trackerEntries } from '../db/schema.js';
import type { Tracker, TrackerEntry, TrackerResult } from './types.js';

/** Built-in tracker: rows in the `tracker_entries` table. Needs no setup. */
export class PostgresTracker implements Tracker {
  readonly id = 'postgres';

  constructor(private readonly db: Db) {}

  async add(entry: TrackerEntry): Promise<TrackerResult> {
    const inserted = await this.db
      .insert(trackerEntries)
      .values({
        jobId: entry.jobId,
        company: entry.company,
        title: entry.title,
        url: entry.url,
        priority: entry.priority,
        source: entry.source,
        salary: entry.salary,
        location: entry.location,
        postedAt: entry.postedAt,
        addedAt: entry.addedAt,
      })
      .onConflictDoNothing({ target: trackerEntries.jobId })
      .returning({ id: trackerEntries.id });

    if (inserted[0]) return { ref: String(inserted[0].id), duplicate: false };
    const [existing] = await this.db
      .select({ id: trackerEntries.id })
      .from(trackerEntries)
      .where(eq(trackerEntries.jobId, entry.jobId))
      .limit(1);
    return { ref: String(existing?.id ?? ''), duplicate: true };
  }
}
