import { describe, expect, it } from 'vitest';
import type { RssFeedConfig } from '../../src/config/schema.js';
import type { SourceHttp } from '../../src/http/session.js';
import { normalizeJob } from '../../src/normalize/normalize.js';
import { ashbyBoardUrl, createAshbySource, mapAshbyJob } from '../../src/sources/ashby.js';
import {
  createGreenhouseSource,
  greenhouseBoardUrl,
  mapGreenhouseJob,
} from '../../src/sources/greenhouse.js';
import { buildSources } from '../../src/sources/registry.js';
import { createRssSource, parseFeed } from '../../src/sources/rss.js';
import { companyFromSlug } from '../../src/sources/types.js';
import { fixture, jsonFixture, testConfig } from '../helpers.js';

const fakeHttp = (responses: Record<string, string | null>): SourceHttp => ({
  getText: (url) => {
    if (!(url in responses)) return Promise.reject(new Error(`unexpected request to ${url}`));
    const body = responses[url] ?? null;
    return Promise.resolve({ notModified: body === null, data: body });
  },
  getJson: <T>(url: string) => {
    if (!(url in responses)) return Promise.reject(new Error(`unexpected request to ${url}`));
    const body = responses[url] ?? null;
    return Promise.resolve({
      notModified: body === null,
      data: body === null ? null : (JSON.parse(body) as T),
    });
  },
});

const feedConfig = (overrides: Partial<RssFeedConfig> = {}): RssFeedConfig => ({
  id: 'example',
  url: 'https://jobs.example.com/feed.rss',
  defaults: {},
  ...overrides,
});

describe('greenhouse', () => {
  const board = jsonFixture<{ jobs: unknown[] }>('greenhouse-board.json');

  it('maps a posting with escaped HTML and a pay range', () => {
    const raw = mapGreenhouseJob(board.jobs[0], 'acmerobotics')!;
    expect(raw).toMatchObject({
      externalId: '4000001',
      url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001',
      title: 'Senior Frontend Engineer',
      company: 'Acme Robotics',
      locationText: 'Remote - Europe',
    });
    expect(raw.postedAt?.toISOString()).toBe('2026-03-01T15:00:00.000Z');
    expect(raw.salary).toMatchObject({ min: 90000, max: 120000, currency: 'EUR', period: 'year' });

    const job = normalizeJob(raw, { id: 'greenhouse:acmerobotics', type: 'greenhouse' });
    expect(job.description).toContain('Acme Robotics builds warehouse robots.');
    expect(job.description).toContain('- Build React and TypeScript interfaces');
    expect(job.description).not.toMatch(/<|&lt;/);
    expect(job.location).toMatchObject({ workMode: 'remote', regions: ['europe'], countries: [] });
    expect(job.remote).toBe(true);
    expect(job.canonicalUrl).toBe('https://greenhouse.io/acmerobotics/jobs/4000001');
  });

  it('falls back to updated_at and reads restrictions from the text', () => {
    const raw = mapGreenhouseJob(board.jobs[1], 'acmerobotics')!;
    expect(raw.postedAt?.toISOString()).toBe('2026-03-03T17:00:00.000Z');
    expect(raw.salary).toBeNull();
    const job = normalizeJob(raw, { id: 'greenhouse:acmerobotics', type: 'greenhouse' });
    expect(job.location.countries).toEqual(['US']);
    expect(job.location.workMode).toBeNull();
  });

  it('skips malformed entries and fetches the whole board', async () => {
    expect(mapGreenhouseJob(board.jobs[2], 'acmerobotics')).toBeNull();
    const source = createGreenhouseSource('acmerobotics', 15);
    const http = fakeHttp({
      [greenhouseBoardUrl('acmerobotics')]: fixture('greenhouse-board.json'),
    });
    const jobs = await source.fetch({ since: null, http });
    expect(source.id).toBe('greenhouse:acmerobotics');
    expect(jobs.map((job) => job.externalId)).toEqual(['4000001', '4000002']);
  });

  it('returns nothing on 304 and fails on an unexpected body', async () => {
    const source = createGreenhouseSource('acmerobotics', 15);
    const url = greenhouseBoardUrl('acmerobotics');
    expect(await source.fetch({ since: null, http: fakeHttp({ [url]: null }) })).toEqual([]);
    await expect(
      source.fetch({ since: null, http: fakeHttp({ [url]: '{"error":"nope"}' }) }),
    ).rejects.toThrow(/unexpected response/);
  });
});

describe('ashby', () => {
  const board = jsonFixture<{ jobs: unknown[] }>('ashby-board.json');

  it('maps a remote posting with structured compensation', () => {
    const raw = mapAshbyJob(board.jobs[0], 'northwind-labs')!;
    expect(raw).toMatchObject({
      externalId: '11111111-1111-4111-8111-111111111111',
      title: 'Senior Full-Stack Engineer',
      company: 'Northwind Labs',
      workMode: 'remote',
      employmentType: 'full_time',
      locationText: 'Remote - European Union; Remote - United Kingdom',
    });
    expect(raw.salary).toEqual({
      min: 90000,
      max: 120000,
      currency: 'EUR',
      period: 'year',
      periodInferred: false,
      text: '€90K - €120K',
    });

    const job = normalizeJob(raw, { id: 'ashby:northwind-labs', type: 'ashby' });
    expect(job.location.regions).toEqual(['eu']);
    expect(job.location.countries).toEqual(['GB']);
    expect(job.description).toContain('React, Next.js');
  });

  it('maps a hybrid contract and parses a text-only compensation summary', () => {
    const raw = mapAshbyJob(board.jobs[1], 'northwind-labs')!;
    expect(raw.workMode).toBe('hybrid');
    expect(raw.employmentType).toBe('contract');
    expect(raw.salary).toMatchObject({ min: 55, max: 55, currency: 'USD', period: 'hour' });
  });

  it('skips unlisted postings', async () => {
    expect(mapAshbyJob(board.jobs[2], 'northwind-labs')).toBeNull();
    const source = createAshbySource('northwind-labs', 15);
    const http = fakeHttp({ [ashbyBoardUrl('northwind-labs')]: fixture('ashby-board.json') });
    expect(await source.fetch({ since: null, http })).toHaveLength(2);
  });
});

describe('rss', () => {
  it('maps RSS items and applies the title pattern', () => {
    const jobs = parseFeed(
      fixture('feed.rss.xml'),
      feedConfig({ title_pattern: '^(?<title>.+) at (?<company>.+)$', defaults: { remote: true } }),
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: 'example-1001',
      url: 'https://jobs.example.com/jobs/1001?utm_source=rss&utm_medium=feed',
      title: 'Senior Frontend Engineer',
      company: 'Acme Robotics',
      workMode: 'remote',
    });
    expect(jobs[0]!.postedAt?.toISOString()).toBe('2026-03-02T08:30:00.000Z');
    expect(jobs[1]).toMatchObject({
      title: 'React Developer & Team Lead',
      company: 'Globex',
      locationText: 'Remote, Worldwide',
    });
    expect(jobs[1]!.descriptionHtml).toContain('Full description');
  });

  it('normalizes a feed item: salary from the body, tracking parameters removed', () => {
    const [raw] = parseFeed(fixture('feed.rss.xml'), feedConfig());
    const job = normalizeJob(raw!, { id: 'rss:example', type: 'rss' });
    expect(job.title).toBe('Senior Frontend Engineer at Acme Robotics');
    expect(job.company).toBe('Example Board');
    expect(job.canonicalUrl).toBe('https://jobs.example.com/jobs/1001');
    expect(job.salary).toMatchObject({ min: 7000, max: 9000, currency: 'USD', period: 'month' });
    expect(job.location).toMatchObject({ workMode: 'remote', regions: ['europe'] });
  });

  it('maps Atom entries', () => {
    const jobs = parseFeed(fixture('feed.atom.xml'), feedConfig());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      externalId: 'urn:example:job:77',
      url: 'https://careers.example.org/jobs/77',
      title: 'Lead Full Stack Engineer',
      company: 'Northwind Labs',
    });
    const job = normalizeJob(jobs[0]!, { id: 'rss:example', type: 'rss' });
    expect(job.description).toBe('Hybrid role in Berlin, Germany.');
  });

  it('uses feed defaults and rejects non-feed documents', async () => {
    const feed = feedConfig({ defaults: { company: 'Globex', employment_type: 'contract' } });
    const xml = `<rss><channel><item><title>Engineer</title><link>https://jobs.example.com/1</link></item></channel></rss>`;
    expect(parseFeed(xml, feed)[0]).toMatchObject({
      company: 'Globex',
      employmentType: 'contract',
    });
    expect(() => parseFeed('<html><body>Not found</body></html>', feed)).toThrow(
      /not an RSS or Atom/,
    );

    const source = createRssSource(feed, 10);
    expect(await source.fetch({ since: null, http: fakeHttp({ [feed.url]: null }) })).toEqual([]);
  });
});

describe('registry', () => {
  it('builds one source per feed and board with the right interval', () => {
    const config = testConfig({
      schedule: { default_interval_minutes: 20 },
      sources: {
        rss: {
          enabled: true,
          interval_minutes: 5,
          feeds: [{ id: 'a', url: 'https://jobs.example.com/a.rss' }],
        },
        greenhouse: { enabled: true, boards: ['acmerobotics', 'acmerobotics'] },
        ashby: { enabled: false, boards: ['northwind-labs'] },
        lever: { enabled: true, companies: ['globex'] },
      },
    });
    const { sources, unsupported } = buildSources(config);
    expect(sources.map((source) => [source.id, source.intervalMinutes])).toEqual([
      ['rss:a', 5],
      ['greenhouse:acmerobotics', 20],
    ]);
    expect(unsupported).toEqual(['lever']);
  });

  it('prettifies board slugs', () => {
    expect(companyFromSlug('northwind-labs')).toBe('Northwind Labs');
    expect(companyFromSlug('acmerobotics')).toBe('Acmerobotics');
  });
});
