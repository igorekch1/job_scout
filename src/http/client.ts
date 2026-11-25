import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} from ${new URL(url).host}`);
    this.name = 'HttpError';
  }
}

export interface Validators {
  etag?: string | null;
  lastModified?: string | null;
}

export interface HttpResponse {
  status: number;
  /** True for 304: the caller's cached copy is still current. */
  notModified: boolean;
  body: string;
  validators: Validators;
}

export interface RequestOptions {
  accept?: string;
  validators?: Validators;
}

export interface HttpClientOptions {
  userAgent: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Retries after the first attempt, for 429, 5xx and network errors. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Minimum gap between two requests to the same host. */
  minHostIntervalMs?: number;
  timeoutMs?: number;
  logger?: Logger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** Parses Retry-After (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Polite HTTP GET: descriptive User-Agent, conditional requests, exponential backoff on
 * 429/5xx (honouring Retry-After) and a per-host minimum interval.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly minHostIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly hostQueues = new Map<string, Promise<void>>();
  private readonly hostLastStart = new Map<string, number>();

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
    this.minHostIntervalMs = options.minHostIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.log = options.logger ?? silentLogger;
  }

  /** Runs `task` after the previous request to the same host, keeping the minimum interval. */
  private async throttled<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.hostQueues.set(host, gate);
    await previous;
    try {
      const wait =
        (this.hostLastStart.get(host) ?? -Infinity) + this.minHostIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.hostLastStart.set(host, this.now());
      return await task();
    } finally {
      release();
      if (this.hostQueues.get(host) === gate) this.hostQueues.delete(host);
    }
  }

  async get(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const host = new URL(url).host;
    const headers: Record<string, string> = {
      'user-agent': this.options.userAgent,
      accept: options.accept ?? '*/*',
    };
    if (options.validators?.etag) headers['if-none-match'] = options.validators.etag;
    if (options.validators?.lastModified) {
      headers['if-modified-since'] = options.validators.lastModified;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let retryAfter: number | null = null;
      try {
        const response = await this.throttled(host, () =>
          this.fetchImpl(url, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        );

        if (response.status === 304) {
          return { status: 304, notModified: true, body: '', validators: options.validators ?? {} };
        }
        if (response.ok) {
          return {
            status: response.status,
            notModified: false,
            body: await response.text(),
            validators: {
              etag: response.headers.get('etag'),
              lastModified: response.headers.get('last-modified'),
            },
          };
        }

        await response.body?.cancel();
        const error = new HttpError(response.status, url);
        if (!isRetryable(response.status)) throw error;
        lastError = error;
        retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      } catch (error) {
        if (error instanceof HttpError && !isRetryable(error.status)) throw error;
        lastError = error;
      }

      if (attempt === this.maxRetries) break;
      const backoff = this.baseDelayMs * 2 ** attempt * (1 + this.random() * 0.25);
      const delay = Math.min(this.maxDelayMs, Math.max(retryAfter ?? 0, backoff));
      this.log.debug(
        { host, attempt: attempt + 1, delayMs: Math.round(delay) },
        'retrying request',
      );
      await this.sleep(delay);
    }

    if (lastError instanceof HttpError) throw lastError;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Request to ${host} failed: ${reason}`);
  }
}
