import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, parseRetryAfter } from '../../src/http/client.js';
import { HttpSession, MemoryValidatorStore } from '../../src/http/session.js';
import { userAgent } from '../../src/version.js';

interface Call {
  url: string;
  headers: Record<string, string>;
}

function harness(responses: (Response | Error)[], options: { minHostIntervalMs?: number } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const client = new HttpClient({
    userAgent: 'job-scout/test',
    maxRetries: 3,
    baseDelayMs: 1000,
    minHostIntervalMs: options.minHostIntervalMs ?? 0,
    random: () => 0,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    fetch: ((url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('no response queued'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }) as unknown as typeof fetch,
  });
  return { client, calls, sleeps };
}

const URL_A = 'https://api.example.com/jobs';

describe('HttpClient', () => {
  it('sends the User-Agent and returns the body with validators', async () => {
    const { client, calls } = harness([
      new Response('hello', {
        status: 200,
        headers: { etag: 'W/"v1"', 'last-modified': 'yesterday' },
      }),
    ]);
    const response = await client.get(URL_A, { accept: 'application/json' });
    expect(response).toEqual({
      status: 200,
      notModified: false,
      body: 'hello',
      validators: { etag: 'W/"v1"', lastModified: 'yesterday' },
    });
    expect(calls[0]!.headers).toMatchObject({
      'user-agent': 'job-scout/test',
      accept: 'application/json',
    });
  });

  it('sends validators and reports 304', async () => {
    const { client, calls } = harness([new Response(null, { status: 304 })]);
    const response = await client.get(URL_A, { validators: { etag: 'W/"v1"', lastModified: 'd' } });
    expect(response.notModified).toBe(true);
    expect(calls[0]!.headers).toMatchObject({
      'if-none-match': 'W/"v1"',
      'if-modified-since': 'd',
    });
  });

  it('backs off exponentially on 5xx and network errors, then succeeds', async () => {
    const { client, calls, sleeps } = harness([
      new Response('', { status: 503 }),
      new Error('socket hang up'),
      new Response('ok', { status: 200 }),
    ]);
    expect((await client.get(URL_A)).body).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('honours Retry-After on 429', async () => {
    const { client, sleeps } = harness([
      new Response('', { status: 429, headers: { 'retry-after': '7' } }),
      new Response('ok', { status: 200 }),
    ]);
    await client.get(URL_A);
    expect(sleeps).toEqual([7000]);
  });

  it('gives up after the retry budget', async () => {
    const { client, calls } = harness([
      new Response('', { status: 500 }),
      new Response('', { status: 500 }),
      new Response('', { status: 500 }),
      new Response('', { status: 500 }),
    ]);
    await expect(client.get(URL_A)).rejects.toMatchObject({ name: 'HttpError', status: 500 });
    expect(calls).toHaveLength(4);
  });

  it('does not retry other client errors', async () => {
    const { client, calls } = harness([new Response('', { status: 404 })]);
    await expect(client.get(URL_A)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('keeps a minimum interval between requests to one host', async () => {
    const { client, sleeps } = harness([new Response('a'), new Response('b'), new Response('c')], {
      minHostIntervalMs: 1000,
    });
    await Promise.all([client.get(URL_A), client.get(`${URL_A}?page=2`)]);
    await client.get('https://other.example.com/');
    expect(sleeps).toEqual([1000]);
  });

  it('parses Retry-After values', () => {
    expect(parseRetryAfter('3', 0)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});

describe('HttpSession', () => {
  it('stores validators only on commit and reuses them afterwards', async () => {
    const store = new MemoryValidatorStore();
    const first = harness([new Response('{"a":1}', { headers: { etag: '"v1"' } })]);
    const session = new HttpSession(first.client, store);
    expect(await session.getJson(URL_A)).toEqual({ notModified: false, data: { a: 1 } });
    expect(await store.get(URL_A)).toBeUndefined();
    await session.commit();
    expect(await store.get(URL_A)).toMatchObject({ etag: '"v1"' });

    const second = harness([new Response(null, { status: 304 })]);
    const next = new HttpSession(second.client, store);
    expect(await next.getJson(URL_A)).toEqual({ notModified: true, data: null });
    expect(second.calls[0]!.headers['if-none-match']).toBe('"v1"');
  });

  it('reports invalid JSON without echoing the body', async () => {
    const { client } = harness([new Response('<html>')]);
    const session = new HttpSession(client, new MemoryValidatorStore());
    await expect(session.getJson(URL_A)).rejects.toThrow(
      'Response from api.example.com is not valid JSON',
    );
  });
});

describe('userAgent', () => {
  it('carries no contact details unless configured', () => {
    expect(userAgent()).toMatch(/^job-scout\/\d+\.\d+\.\d+$/);
    expect(userAgent(' https://example.com/about ')).toMatch(
      /^job-scout\/[\d.]+ \(\+https:\/\/example\.com\/about\)$/,
    );
  });
});
