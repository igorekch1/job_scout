import type { HttpClient, Validators } from './client.js';

/** Where ETag / Last-Modified validators are kept between runs. */
export interface ValidatorStore {
  get(url: string): Promise<Validators | undefined>;
  set(url: string, validators: Validators): Promise<void>;
}

export class MemoryValidatorStore implements ValidatorStore {
  private readonly entries = new Map<string, Validators>();

  get(url: string): Promise<Validators | undefined> {
    return Promise.resolve(this.entries.get(url));
  }

  set(url: string, validators: Validators): Promise<void> {
    this.entries.set(url, validators);
    return Promise.resolve();
  }
}

export interface FetchResult<T> {
  /** True when the server answered 304 Not Modified: nothing new since the last run. */
  notModified: boolean;
  data: T | null;
}

/** What a source uses to talk to the network. */
export interface SourceHttp {
  getText(url: string, accept?: string): Promise<FetchResult<string>>;
  getJson<T = unknown>(url: string): Promise<FetchResult<T>>;
}

/**
 * One source run. Validators learned during the run are written only on `commit()`, after the
 * fetched jobs are safely stored. A run that crashes half-way therefore fetches the same
 * content again instead of receiving 304 and losing it.
 */
export class HttpSession implements SourceHttp {
  private readonly pending = new Map<string, Validators>();

  constructor(
    private readonly client: HttpClient,
    private readonly store: ValidatorStore,
    private readonly conditional = true,
  ) {}

  async getText(url: string, accept = '*/*'): Promise<FetchResult<string>> {
    const validators = this.conditional ? await this.store.get(url) : undefined;
    const response = await this.client.get(url, { accept, validators });
    if (response.notModified) return { notModified: true, data: null };
    if (response.validators.etag || response.validators.lastModified) {
      this.pending.set(url, response.validators);
    }
    return { notModified: false, data: response.body };
  }

  async getJson<T = unknown>(url: string): Promise<FetchResult<T>> {
    const result = await this.getText(url, 'application/json');
    if (result.notModified || result.data === null) return { notModified: true, data: null };
    try {
      return { notModified: false, data: JSON.parse(result.data) as T };
    } catch {
      throw new Error(`Response from ${new URL(url).host} is not valid JSON`);
    }
  }

  async commit(): Promise<void> {
    for (const [url, validators] of this.pending) {
      await this.store.set(url, validators);
    }
    this.pending.clear();
  }
}
