/** What "Add to tracker" hands to a tracker adapter. */
export interface TrackerEntry {
  jobId: number;
  company: string | null;
  title: string;
  /** Primary link: the employer's own ATS page when known. */
  url: string;
  /** Every link the job was seen at, primary first. */
  links: string[];
  /** Source type of the primary link, e.g. "greenhouse". */
  source: string;
  /** Human-readable pay, e.g. "$120k–150k / year". */
  salary: string | null;
  location: string | null;
  workMode: string | null;
  employmentType: string | null;
  priority: string | null;
  postedAt: Date | null;
  addedAt: Date;
}

export interface TrackerResult {
  /** Identifier of the row in the tracker. */
  ref: string;
  /** Link to the row, when the tracker has one. */
  url?: string;
  /** True when the job was already there and nothing was written. */
  duplicate: boolean;
}

/**
 * Where "Add to tracker" writes. To add one (Google Sheets, Airtable, ...): implement this
 * interface and return it from `createTracker`. See docs/adding-a-tracker.md.
 */
export interface Tracker {
  readonly id: string;
  /** Must be idempotent per `entry.jobId`. Throw on failure; the bot reports the message. */
  add(entry: TrackerEntry): Promise<TrackerResult>;
}
