import { describe, expect, it } from 'vitest';
import { normalizeJob } from '../../src/normalize/normalize.js';
import { extractLinks, parsePost, type ChannelPost } from '../../src/sources/telegram/post.js';
import type { ChannelReader } from '../../src/sources/telegram/reader.js';
import {
  createTelegramChannelSource,
  normalizeChannel,
} from '../../src/sources/telegram/source.js';
import { testConfig } from '../helpers.js';
import { filterJob } from '../../src/filters/index.js';

const post = (text: string, extra: Partial<ChannelPost> = {}): ChannelPost => ({
  id: 101,
  date: new Date('2026-03-05T09:00:00Z'),
  text,
  links: extractLinks(text),
  ...extra,
});

const LABELED_EN = `🔥 #vacancy #react

Position: Senior React Developer
Company: Acme Robotics
Location: Remote (Europe)
Salary: $5000-6500 per month

We build warehouse robots. You will own the operator dashboard in React and TypeScript.

Apply: https://jobs.example.com/acme/senior-react?utm_source=telegram`;

const FREE_UA = `**Senior Frontend Engineer в Northwind Labs**

Формат: віддалено
Зарплата: до $6000

Шукаємо інженера на продукт для логістики. Стек: React, Next.js, TypeScript.
Деталі: https://t.me/northwind_hr`;

describe('parsePost', () => {
  it('reads labelled fields and the external apply link', () => {
    const raw = parsePost(post(LABELED_EN), 'example_jobs')!;
    expect(raw).toMatchObject({
      externalId: 'example_jobs/101',
      url: 'https://jobs.example.com/acme/senior-react?utm_source=telegram',
      title: 'Senior React Developer',
      company: 'Acme Robotics',
      locationText: 'Remote (Europe)',
      salaryText: '$5000-6500 per month',
    });
    expect(raw.descriptionText).toContain('Source post: https://t.me/example_jobs/101');

    const job = normalizeJob(raw, { id: 'telegram:example_jobs', type: 'telegram' });
    expect(job).toMatchObject({
      remote: true,
      canonicalUrl: 'https://jobs.example.com/acme/senior-react',
    });
    expect(job.location.regions).toEqual(['europe']);
    expect(job.salary).toMatchObject({ min: 5000, max: 6500, currency: 'USD', period: 'month' });
  });

  it('reads "Title в Company" headers and Ukrainian labels, keeping the post link when there is no other', () => {
    const raw = parsePost(post(FREE_UA), 'ua_jobs')!;
    expect(raw).toMatchObject({
      url: 'https://t.me/ua_jobs/101',
      title: 'Senior Frontend Engineer',
      company: 'Northwind Labs',
      locationText: 'віддалено',
      salaryText: 'до $6000',
    });
    const job = normalizeJob(
      raw,
      { id: 'telegram:ua_jobs', type: 'telegram' },
      { remoteKeywords: ['віддалено'] },
    );
    expect(job.location.workMode).toBe('remote');
    expect(job.salary).toMatchObject({ min: null, max: 6000, currency: 'USD' });
  });

  it('uses link entities hidden behind text', () => {
    const raw = parsePost(
      post(
        'Lead Frontend Engineer at Globex\n\nRemote, React and TypeScript, product team of 12. Apply here.',
        {
          links: ['https://careers.example.org/jobs/77'],
        },
      ),
      'example_jobs',
    )!;
    expect(raw).toMatchObject({
      title: 'Lead Frontend Engineer',
      company: 'Globex',
      url: 'https://careers.example.org/jobs/77',
    });
  });

  it('skips posts that are not job postings', () => {
    expect(parsePost(post('Good morning! New posts tomorrow.'), 'example_jobs')).toBeNull();
    expect(
      parsePost(
        post(
          'Our channel has 10,000 subscribers now. Thank you all for reading and sharing the news with friends!',
        ),
        'example_jobs',
      ),
    ).toBeNull();
  });

  it('feeds blocked signals to the filter like any other source', () => {
    const raw = parsePost(post(`${LABELED_EN}\nОплата в ₽`), 'example_jobs')!;
    const job = normalizeJob(raw, { id: 'telegram:example_jobs', type: 'telegram' });
    const config = testConfig({ filters: { location: { always_blocked: { signals: ['₽'] } } } });
    expect(filterJob(job, config).dropReasons).toEqual(['blocked_signal']);
  });
});

describe('telegram channel source', () => {
  it('normalizes channel names', () => {
    expect(normalizeChannel('@example_jobs')).toBe('example_jobs');
    expect(normalizeChannel('https://t.me/example_jobs/')).toBe('example_jobs');
  });

  it('reads the newest posts, skips old ones and non-jobs', async () => {
    const reads: [string, number][] = [];
    const reader: ChannelReader = {
      read: (channel, limit) => {
        reads.push([channel, limit]);
        return Promise.resolve([
          post(LABELED_EN, { id: 3 }),
          post('Short note.', { id: 2 }),
          post(FREE_UA, { id: 1, date: new Date('2026-02-01T00:00:00Z') }),
        ]);
      },
      close: () => Promise.resolve(),
    };
    const source = createTelegramChannelSource('@example_jobs', reader, 15, 30);
    expect(source).toMatchObject({ id: 'telegram:example_jobs', type: 'telegram' });

    const firstRun = await source.fetch({ since: null, http: undefined as never });
    expect(firstRun.map((job) => job.externalId)).toEqual(['example_jobs/3', 'example_jobs/1']);

    const later = await source.fetch({
      since: new Date('2026-03-05T00:00:00Z'),
      http: undefined as never,
    });
    expect(later.map((job) => job.externalId)).toEqual(['example_jobs/3']);
    expect(reads[0]).toEqual(['example_jobs', 30]);
  });
});
