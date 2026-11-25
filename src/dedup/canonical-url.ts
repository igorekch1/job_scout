const TRACKING_PARAMS = new Set([
  'ref',
  'referrer',
  'source',
  'src',
  'gh_src',
  'lever-source',
  'lever-origin',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'trk',
  'trackingid',
  'campaign',
]);

export type AtsType = 'greenhouse' | 'ashby' | 'lever';

/** Which employer-hosted ATS a URL points to, if any. */
export function atsFromUrl(url: string): AtsType | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.endsWith('greenhouse.io')) return 'greenhouse';
  if (host.endsWith('ashbyhq.com')) return 'ashby';
  if (host.endsWith('lever.co')) return 'lever';
  return null;
}

/**
 * Reduces a posting URL to a stable form, so the same posting reached through different links
 * (tracking parameters, "www.", "/apply" pages, old and new ATS hosts) compares equal.
 */
export function canonicalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return input.trim();
  }

  let host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.replace(/\/{2,}/g, '/');

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    host = 'greenhouse.io';
  }
  if (host === 'jobs.ashbyhq.com') {
    path = path.replace(/\/application\/?$/i, '');
    // board names are case-insensitive
    path = path.replace(/^\/([^/]+)/, (_, board: string) => `/${board.toLowerCase()}`);
  }
  if (host === 'jobs.lever.co') {
    path = path.replace(/\/apply\/?$/i, '');
  }
  path = path.length > 1 ? path.replace(/\/+$/, '') : path;

  const params = [...url.searchParams.entries()]
    .filter(([key]) => {
      const name = key.toLowerCase();
      return !name.startsWith('utm_') && !TRACKING_PARAMS.has(name);
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : '';

  return `https://${host}${path}${query}`;
}
