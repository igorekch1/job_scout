/** Minimal Notion API client: the three calls the tracker needs, with polite retries. */

export class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

export interface NotionClientOptions {
  token: string;
  version: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Notion allows about 3 requests per second per integration. */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface NotionPropertySchema {
  id: string;
  name: string;
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  status?: { options: { name: string }[] };
}

export interface NotionDataSource {
  id: string;
  properties: Record<string, NotionPropertySchema>;
}

export interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, { type?: string; number?: number | null }>;
}

export interface NotionQueryResult {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const BASE = 'https://api.notion.com/v1';
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Messages that tell the user what to fix, keyed by Notion error code. */
const HINTS: Readonly<Record<string, string>> = {
  unauthorized: 'NOTION_TOKEN is invalid or revoked',
  object_not_found:
    'the data source was not found: check tracker.notion.data_source_id and share the database with your integration',
  restricted_resource: 'the integration lacks permission: give it "Insert content" access',
  validation_error: 'Notion rejected the values',
};

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private queue: Promise<void> = Promise.resolve();
  private lastStart = -Infinity;

  constructor(private readonly options: NotionClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.minIntervalMs = options.minIntervalMs ?? 350;
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async slot(): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = Date.now();
    release();
  }

  /**
   * `idempotent` requests are retried on 5xx too. A page create is not: Notion may have stored
   * it already, and the tracker's duplicate check covers a manual retry.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    idempotent: boolean,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      await this.slot();
      let response: Response;
      try {
        response = await this.fetchImpl(`${BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.options.token}`,
            'notion-version': this.options.version,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (idempotent && attempt < this.maxRetries) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new NotionError(0, 'network_error', `Notion is unreachable: ${reason}`);
      }

      if (response.ok) return (await response.json()) as T;

      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      const code = payload.code ?? `http_${response.status}`;
      const retryable =
        response.status === 429 ||
        response.status === 529 ||
        (idempotent && response.status >= 500 && response.status <= 504);
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await this.sleep(Math.min(delay, 60_000));
        continue;
      }
      const hint = HINTS[code];
      const detail = payload.message ? `: ${payload.message}` : '';
      throw new NotionError(
        response.status,
        code,
        `Notion ${response.status} ${code}${hint ? ` (${hint})` : ''}${detail}`,
      );
    }
  }

  retrieveDataSource(id: string): Promise<NotionDataSource> {
    return this.request('GET', `/data_sources/${encodeURIComponent(id)}`, undefined, true);
  }

  queryDataSource(id: string, body: Record<string, unknown>): Promise<NotionQueryResult> {
    return this.request('POST', `/data_sources/${encodeURIComponent(id)}/query`, body, true);
  }

  createPage(body: Record<string, unknown>): Promise<NotionPage> {
    return this.request('POST', '/pages', body, false);
  }
}
