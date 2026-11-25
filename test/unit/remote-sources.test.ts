import { describe, expect, it } from 'vitest';
import type { SourceHttp } from '../../src/http/session.js';
import { normalizeJob } from '../../src/normalize/normalize.js';
import { createLeverSource, leverBoardUrl, mapLeverJob } from '../../src/sources/lever.js';
import {
  createHimalayasSource,
  createJobicySource,
  createRemoteOkSource,
  createRemotiveSource,
  himalayasUrl,
  jobicyUrl,
  mapHimalayasJob,
  mapRemotiveJob,
  remoteOkUrl,
  remotiveUrl,
} from '../../src/sources/remote-boards.js';
import { buildSources } from '../../src/sources/registry.js';
import { fixture, jsonFixture, testConfig } from '../helpers.js';

const http = (responses: Record<string, string>): SourceHttp & { urls: string[] } => {
  const urls: string[] = [];
  return {
    urls,
    getText: (url) => {
      urls.push(url);
      return Promise.resolve({ notModified: false, data: responses[url] ?? null });
    },
    getJson: <T>(url: string) => {
      urls.push(url);
      if (!(url in responses)) return Promise.reject(new Error(`unexpected request to ${url}`));
      return Promise.resolve({ notModified: false, data: JSON.parse(responses[url]!) as T });
    },
  };
};

describe('lever', () => {
  it('maps a posting with lists, salary range and workplace type', () => {
    const [first] = jsonFixture<unknown[]>('lever-board.json');
    const raw = mapLeverJob(first, 'globex')!;
    expect(raw).toMatchObject({
      externalId: 'aaaaaaaa-0000-4000-8000-000000000001',
      title: 'Senior Frontend Engineer',
      company: 'Globex',
      locationText: 'Remote - Europe; Lisbon',
      workMode: 'remote',
      employmentType: 'full_time',
      salary: { min: 6000, max: 8000, currency: 'EUR', period: 'month' },
    });
    expect(raw.postedAt?.toISOString()).toBe('2026-03-05T12:00:00.000Z');
    const job = normalizeJob(raw, { id: 'lever:globex', type: 'lever' });
    expect(job.description).toContain('Build React and TypeScript features');
    expect(job.description).toContain('learning budget');
  });

  it('maps commitment and on-site wording, skips malformed entries and uses the EU host', async () => {
    const board = jsonFixture<unknown[]>('lever-board.json');
    expect(mapLeverJob(board[1], 'globex')).toMatchObject({
      workMode: 'onsite',
      employmentType: 'part_time',
    });
    expect(mapLeverJob(board[2], 'globex')).toBeNull();
    expect(leverBoardUrl('globex', true)).toBe(
      'https://api.eu.lever.co/v0/postings/globex?mode=json',
    );
    const jobs = await createLeverSource('globex', 15).fetch({
      since: null,
      http: http({ [leverBoardUrl('globex')]: fixture('lever-board.json') }),
    });
    expect(jobs).toHaveLength(2);
  });
});

describe('remotive', () => {
  it('reads timestamps as UTC and keeps the salary text', () => {
    const { jobs } = jsonFixture<{ jobs: unknown[] }>('remotive.json');
    const raw = mapRemotiveJob(jobs[0])!;
    expect(raw.postedAt?.toISOString()).toBe('2026-03-04T10:31:32.000Z');
    const job = normalizeJob(raw, { id: 'remotive:software-dev', type: 'remotive' });
    expect(job).toMatchObject({
      remote: true,
      employmentType: 'full_time',
      company: 'Northwind Labs',
    });
    expect(job.salary).toMatchObject({ min: 90000, max: 110000, currency: 'USD', period: 'year' });
    expect(job.location.regions).toEqual(['europe']);
  });

  it('makes one request per run and filters by keyword locally', async () => {
    const client = http({ [remotiveUrl('software-dev')]: fixture('remotive.json') });
    const source = createRemotiveSource({ category: 'software-dev', search: ['react'] }, 360);
    const jobs = await source.fetch({ since: null, http: client });
    expect(jobs.map((job) => job.title)).toEqual(['Senior React Engineer']);
    expect(client.urls).toEqual(['https://remotive.com/api/remote-jobs?category=software-dev']);
  });
});

describe('remoteok', () => {
  it('skips the legal notice, reads yearly USD salaries and queries one tag per request', async () => {
    const client = http({ [remoteOkUrl()]: fixture('remoteok.json') });
    const all = await createRemoteOkSource({ tags: [] }, 60).fetch({ since: null, http: client });
    expect(all.map((job) => job.externalId)).toEqual(['900001', '900002']);
    expect(all[0]!.salary).toMatchObject({
      min: 100000,
      max: 130000,
      currency: 'USD',
      period: 'year',
    });
    expect(all[1]!.salary).toBeNull();
    const job = normalizeJob(all[0]!, { id: 'remoteok', type: 'remoteok' });
    expect(job.description).toBe('Remote role building React UIs.');

    const tagged = http({
      [remoteOkUrl('react')]: fixture('remoteok.json'),
      [remoteOkUrl('javascript')]: fixture('remoteok.json'),
    });
    const jobs = await createRemoteOkSource({ tags: ['react', 'javascript'] }, 60).fetch({
      since: null,
      http: tagged,
    });
    expect(jobs).toHaveLength(2); // the same jobs from both tags are kept once
    expect(tagged.urls).toEqual([
      'https://remoteok.com/api?tag=react',
      'https://remoteok.com/api?tag=javascript',
    ]);
  });
});

describe('jobicy', () => {
  it('maps salary and type, and passes geo and industry to the API', async () => {
    const url = jobicyUrl({ geo: 'europe', industry: 'engineering' });
    expect(url).toBe('https://jobicy.com/api/jobs?count=100&geo=europe&industry=engineering');
    const jobs = await createJobicySource(
      { tags: ['vue'], geo: 'europe', industry: 'engineering' },
      60,
    ).fetch({
      since: null,
      http: http({ [url]: fixture('jobicy.json') }),
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Lead Frontend Engineer',
      locationText: 'EMEA',
      employmentType: 'full_time',
      salary: { min: 80000, max: 95000, currency: 'EUR', period: 'year' },
    });
  });
});

describe('himalayas', () => {
  it('links to the Himalayas page and reads an empty restriction list as worldwide', () => {
    const { jobs } = jsonFixture<{ jobs: unknown[] }>('himalayas.json');
    const first = mapHimalayasJob(jobs[0])!;
    expect(first).toMatchObject({
      url: 'https://himalayas.app/companies/northwind-labs/jobs/senior-full-stack-engineer',
      locationText: 'Netherlands; Germany',
      salary: { min: 70000, max: 90000, currency: 'EUR', period: 'year' },
      employmentType: 'full_time',
    });
    const second = mapHimalayasJob(jobs[1])!;
    expect(second).toMatchObject({
      locationText: 'Worldwide',
      employmentType: 'contract',
      salary: null,
    });
    const job = normalizeJob(second, { id: 'himalayas', type: 'himalayas' });
    expect(job.location.regions).toEqual(['worldwide']);
  });

  it('runs one newest-first search per query', async () => {
    const client = http({
      [himalayasUrl('react')]: fixture('himalayas.json'),
      [himalayasUrl('vue')]: '{"jobs":[]}',
    });
    const jobs = await createHimalayasSource({ queries: ['react', 'vue'] }, 60).fetch({
      since: null,
      http: client,
    });
    expect(jobs).toHaveLength(2);
    expect(client.urls).toEqual([
      'https://himalayas.app/jobs/api/search?q=react&sort=recent',
      'https://himalayas.app/jobs/api/search?q=vue&sort=recent',
    ]);
  });
});

describe('registry', () => {
  it('builds the public API sources and enforces provider minimum intervals', () => {
    const config = testConfig({
      schedule: { default_interval_minutes: 10 },
      sources: {
        lever: { enabled: true, companies: ['globex'], eu_companies: ['initech'] },
        remotive: { enabled: true, category: 'software-dev', interval_minutes: 30 },
        remoteok: { enabled: true },
        jobicy: { enabled: true, interval_minutes: 120 },
        himalayas: { enabled: true, queries: ['react'] },
        telegram_channels: { enabled: true, channels: ['example'] },
      },
    });
    const { sources, unsupported } = buildSources(config);
    expect(sources.map((source) => [source.id, source.intervalMinutes])).toEqual([
      ['lever:globex', 10],
      ['lever:initech', 10],
      ['himalayas', 60],
      ['remotive:software-dev', 360],
      ['remoteok', 60],
      ['jobicy', 120],
      ['telegram:example', 10],
    ]);
    expect(unsupported).toEqual([]);
  });
});
