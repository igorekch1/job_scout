import { HttpError, type HttpClient } from '../http/client.js';
import { errorMessage } from '../logger.js';
import { ashbyBoardUrl } from '../sources/ashby.js';
import { greenhouseJobUrl } from '../sources/greenhouse.js';
import { leverApiBase } from '../sources/lever.js';

export type LivenessStatus = 'open' | 'closed' | 'unknown';

export interface Liveness {
  status: LivenessStatus;
  /** How the answer was reached, for the user and the logs. */
  detail: string;
}

export interface LivenessTarget {
  primaryUrl: string;
  links: readonly { sourceType: string; sourceId: string; externalId: string; url: string }[];
}

const CLOSED_TEXT =
  /no longer (?:available|accepting|open)|(?:position|role|job|vacancy) (?:has been |is |was )?(?:filled|closed|expired|removed)|job (?:has )?expired|posting (?:has )?(?:closed|expired)|this job is closed/i;

const GONE = new Set([404, 410]);

type Get = HttpClient['get'];

async function probe(run: () => Promise<Liveness>): Promise<Liveness> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError && GONE.has(error.status)) {
      return { status: 'closed', detail: `the posting returned HTTP ${error.status}` };
    }
    return { status: 'unknown', detail: errorMessage(error) };
  }
}

/** Greenhouse answers 404 for a job that is no longer published. */
const checkGreenhouse = (get: Get, board: string, jobId: string): Promise<Liveness> =>
  probe(async () => {
    await get(greenhouseJobUrl(board, jobId), { accept: 'application/json' });
    return { status: 'open', detail: 'listed on the Greenhouse board' };
  });

/** Ashby has no per-job endpoint: a closed job disappears from the board listing. */
const checkAshby = (get: Get, board: string, jobId: string): Promise<Liveness> =>
  probe(async () => {
    const response = await get(ashbyBoardUrl(board), { accept: 'application/json' });
    const jobs = (JSON.parse(response.body) as { jobs?: { id?: unknown; isListed?: unknown }[] })
      .jobs;
    if (!Array.isArray(jobs)) return { status: 'unknown', detail: 'unexpected Ashby response' };
    const listed = jobs.some((job) => job.id === jobId && job.isListed !== false);
    return listed
      ? { status: 'open', detail: 'listed on the Ashby board' }
      : { status: 'closed', detail: 'no longer listed on the Ashby board' };
  });

const checkPage = (get: Get, url: string, extra: readonly RegExp[]): Promise<Liveness> =>
  probe(async () => {
    const response = await get(url, { accept: 'text/html, */*;q=0.5' });
    const body = response.body.slice(0, 200_000);
    return [CLOSED_TEXT, ...extra].some((pattern) => pattern.test(body))
      ? { status: 'closed', detail: 'the page says the posting is closed' }
      : { status: 'open', detail: 'the page is reachable' };
  });

/** "https://job-boards.greenhouse.io/<board>/jobs/<id>" reached through an aggregator. */
function greenhouseFromUrl(url: string): { board: string; jobId: string } | null {
  const match = /^https?:\/\/(?:job-)?boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i.exec(url);
  return match ? { board: match[1]!, jobId: match[2]! } : null;
}

/**
 * Confirms a posting is still open before it goes into the tracker. Uses the ATS API when the
 * job is known there, otherwise fetches the primary page. "unknown" means the check itself
 * failed (network error, rate limit): the caller decides what to do.
 */
export interface LivenessOptions {
  /** Extra regular expressions that mark a page as closed (`tracker.closed_patterns`). */
  closedPatterns?: readonly string[];
}

export async function checkLiveness(
  target: LivenessTarget,
  http: HttpClient,
  options: LivenessOptions = {},
): Promise<Liveness> {
  const get: Get = (url, options) => http.get(url, options);
  const slugOf = (sourceId: string): string => sourceId.slice(sourceId.indexOf(':') + 1);

  const greenhouse = target.links.find((link) => link.sourceType === 'greenhouse');
  if (greenhouse) return checkGreenhouse(get, slugOf(greenhouse.sourceId), greenhouse.externalId);

  const lever = target.links.find((link) => link.sourceType === 'lever');
  if (lever) {
    // Lever answers 404 for a posting that is no longer published
    return probe(async () => {
      const site = slugOf(lever.sourceId);
      const eu = /\.eu\.lever\.co/i.test(lever.url);
      await get(
        `${leverApiBase(eu)}/${encodeURIComponent(site)}/${encodeURIComponent(lever.externalId)}?mode=json`,
        {
          accept: 'application/json',
        },
      );
      return { status: 'open', detail: 'listed on the Lever board' };
    });
  }

  const ashby = target.links.find((link) => link.sourceType === 'ashby');
  if (ashby) return checkAshby(get, slugOf(ashby.sourceId), ashby.externalId);

  for (const url of [target.primaryUrl, ...target.links.map((link) => link.url)]) {
    const viaUrl = greenhouseFromUrl(url);
    if (viaUrl) return checkGreenhouse(get, viaUrl.board, viaUrl.jobId);
  }
  const extra = (options.closedPatterns ?? []).map((source) => new RegExp(source, 'iu'));
  return checkPage(get, target.primaryUrl, extra);
}
