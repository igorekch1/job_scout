import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deliveries,
  feedback,
  jobLinks,
  jobs,
  sourceRuns,
  sourceState,
  trackerEntries,
} from '../../src/db/schema.js';
import { ashbyBoardUrl } from '../../src/sources/ashby.js';
import { greenhouseBoardUrl, greenhouseJobUrl } from '../../src/sources/greenhouse.js';
import { fixture, testConfig } from '../helpers.js';
import { advance, CHAT, createHarness, type Harness } from './harness.js';

const FEED_URL = 'https://jobs.example.com/feeds/frontend.rss';
const GREENHOUSE = greenhouseBoardUrl('acmerobotics');
const ASHBY = ashbyBoardUrl('northwind-labs');
const START = '2026-03-05T12:00:00Z';

const config = (overrides: Record<string, unknown> = {}) =>
  testConfig({
    // one source at a time keeps the order of events the same on every run
    schedule: { max_concurrent_sources: 1 },
    sources: {
      greenhouse: { enabled: true, boards: ['acmerobotics'] },
      ashby: { enabled: true, boards: ['northwind-labs'] },
      rss: {
        enabled: true,
        feeds: [
          { id: 'example', url: FEED_URL, title_pattern: '^(?<title>.+) at (?<company>.+)$' },
        ],
      },
    },
    filters: {
      max_age_days: 7,
      title: { include_any: ['frontend', 'full-stack', 'react'], exclude_any: ['designer'] },
      seniority: { include_any: ['senior', 'lead'], exclude_any: ['staff'] },
    },
    ...overrides,
  });

let h: Harness;

const serveAll = (harness: Harness): void => {
  harness.web
    .set(GREENHOUSE, fixture('greenhouse-board.json'))
    .set(ASHBY, fixture('ashby-board.json'))
    .set(FEED_URL, fixture('feed.rss.xml'));
};

const jobByTitle = async (title: string) => {
  const [row] = await h.db.select().from(jobs).where(eq(jobs.title, title)).limit(1);
  return row!;
};

afterEach(async () => {
  await h?.close();
});

describe('collect, filter and deliver', () => {
  beforeEach(async () => {
    h = await createHarness(config(), START);
    serveAll(h);
  });

  it('stores jobs from every source, merges duplicates and records why jobs were dropped', async () => {
    await h.collect();

    const stored = await h.db.select().from(jobs).orderBy(jobs.id);
    const byTitle = Object.fromEntries(stored.map((job) => [job.title, job]));
    expect(Object.keys(byTitle).sort()).toEqual([
      'Product Designer',
      'React Developer & Team Lead',
      'Senior Frontend Engineer',
      'Senior Full-Stack Engineer',
      'Staff Backend Engineer (Java)',
    ]);

    expect(byTitle['Senior Frontend Engineer']).toMatchObject({
      verdict: 'pass',
      company: 'Acme Robotics',
    });
    expect(byTitle['Senior Full-Stack Engineer']).toMatchObject({
      verdict: 'pass',
      workMode: 'remote',
    });
    expect(byTitle['React Developer & Team Lead']!.verdict).toBe('flag');
    expect(byTitle['Staff Backend Engineer (Java)']).toMatchObject({
      verdict: 'drop',
      dropReasons: ['title_not_included', 'seniority_excluded', 'location_restricted'],
    });
    expect(byTitle['Product Designer']!.dropReasons).toEqual(['title_excluded', 'location_onsite']);

    // the feed item and the Greenhouse posting are the same role: one job, two links
    const frontend = byTitle['Senior Frontend Engineer']!;
    const links = await h.db.select().from(jobLinks).where(eq(jobLinks.jobId, frontend.id));
    expect(links.map((link) => link.sourceId).sort()).toEqual([
      'greenhouse:acmerobotics',
      'rss:example',
    ]);
    expect(frontend.primarySourceType).toBe('greenhouse');
    expect(frontend.primaryUrl).toBe('https://job-boards.greenhouse.io/acmerobotics/jobs/4000001');

    const states = await h.db.select().from(sourceState);
    expect(states).toHaveLength(3);
    expect(states.every((state) => state.initialized && state.lastError === null)).toBe(true);
  });

  it('queues kept jobs only and sends one card each through the bot', async () => {
    await h.collect();
    const queued = await h.db.select().from(deliveries);
    expect(queued).toHaveLength(3);
    expect(queued.every((row) => row.chatId === CHAT && row.status === 'pending')).toBe(true);

    expect(await h.outbox.tick()).toEqual({ cards: 3, digests: 0, failed: 0 });
    const messages = h.sent();
    expect(messages).toHaveLength(3);
    const card = messages.find((call) =>
      String(call.payload.text).includes('Senior Frontend Engineer'),
    )!;
    expect(card.payload).toMatchObject({ chat_id: CHAT, parse_mode: 'HTML' });
    expect(card.payload.text).toContain('Acme Robotics');
    expect(card.payload.text).toContain('€90k–120k / year');
    expect(card.payload.text).toContain('Remote - Europe');
    expect(card.payload.text).toContain('posted 1 Mar');
    expect(card.payload.text).toContain(
      '>Greenhouse</a> · <a href="https://jobs.example.com/jobs/1001',
    );
    expect(JSON.stringify(card.payload.reply_markup)).toContain('Add to tracker');

    // nothing is sent twice
    expect(await h.outbox.tick()).toEqual({ cards: 0, digests: 0, failed: 0 });
    expect((await h.db.select().from(deliveries)).every((row) => row.status === 'sent')).toBe(true);
  });

  it('uses conditional requests and finds nothing new on the next run', async () => {
    await h.collect();
    advance(h, 20);
    await h.collect();

    expect(h.web.requestsTo(GREENHOUSE)).toBe(2);
    expect(h.web.requests.at(-1)!.headers['if-none-match']).toBeDefined();
    expect(await h.db.select().from(jobs)).toHaveLength(5);
    const runs = await h.db.select().from(sourceRuns);
    expect(runs).toHaveLength(6);
    expect(runs.slice(3).every((run) => run.ok && run.fetched === 0)).toBe(true);
  });

  it('does not run a source again before its interval has passed', async () => {
    await h.collect();
    advance(h, 5);
    await h.collect();
    expect(h.web.requestsTo(GREENHOUSE)).toBe(1);
  });

  it('keeps going when one source fails and reports it in /status', async () => {
    h.web.set(ASHBY, { status: 503 });
    await h.collect();

    const states = Object.fromEntries(
      (await h.db.select().from(sourceState)).map((state) => [state.sourceId, state]),
    );
    expect(states['ashby:northwind-labs']).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'HTTP 503 from api.ashbyhq.com',
      initialized: false,
    });
    expect(states['greenhouse:acmerobotics']!.lastError).toBeNull();
    expect(await h.db.select().from(jobs)).toHaveLength(3);

    await h.say('/status');
    const status = h.lastText();
    expect(status).toContain('❌ ashby:northwind-labs');
    expect(status).toContain('HTTP 503 from api.ashbyhq.com (1 failure)');
    expect(status).toContain('✅ greenhouse:acmerobotics');
    expect(status).toContain('2 fetched, 2 new, 1 kept');

    // a failing source backs off: twice the interval after one failure
    advance(h, 20);
    await h.collect();
    expect(h.web.requestsTo(ASHBY)).toBe(1);
    h.web.set(ASHBY, fixture('ashby-board.json'));
    advance(h, 15);
    await h.collect();
    expect(h.web.requestsTo(ASHBY)).toBe(2);
    expect(await h.db.select().from(jobs)).toHaveLength(5);
  });
});

describe('deduplication across sources', () => {
  it('promotes the employer ATS link when the aggregator was seen first', async () => {
    h = await createHarness(config(), START);
    h.web
      .set(FEED_URL, fixture('feed.rss.xml'))
      .set(ASHBY, '{"jobs":[]}')
      .set(GREENHOUSE, '{"jobs":[]}');
    await h.collect();
    expect((await jobByTitle('Senior Frontend Engineer')).primarySourceType).toBe('rss');

    h.web.set(GREENHOUSE, fixture('greenhouse-board.json'));
    advance(h, 20);
    await h.collect();

    const job = await jobByTitle('Senior Frontend Engineer');
    expect(job.primarySourceType).toBe('greenhouse');
    expect(job.primaryUrl).toBe('https://job-boards.greenhouse.io/acmerobotics/jobs/4000001');
    // the employer's own pay range replaces the one read from the feed text
    expect(job).toMatchObject({ salaryMin: 90000, salaryMax: 120000, salaryCurrency: 'EUR' });
    // and the job is still announced once
    expect(await h.db.select().from(deliveries).where(eq(deliveries.jobId, job.id))).toHaveLength(
      1,
    );
  });

  it('stores undated postings silently on the first run of a source', async () => {
    h = await createHarness(config({ filters: {} }), START);
    serveAll(h);
    await h.collect();
    const undated = await jobByTitle('Staff Backend Engineer (Java)');
    expect(undated.postedAt).not.toBeNull();

    const feed = `<rss><channel>
      <item><title>Senior React Engineer at Globex</title><link>https://jobs.example.com/jobs/2001</link></item>
    </channel></rss>`;
    const fresh = await createHarness(config({ filters: {} }), START);
    try {
      fresh.web.set(FEED_URL, feed).set(GREENHOUSE, '{"jobs":[]}').set(ASHBY, '{"jobs":[]}');
      await fresh.collect();
      const [first] = await fresh.db.select().from(jobs);
      expect(first).toMatchObject({ silent: true, verdict: 'flag' });
      expect(await fresh.db.select().from(deliveries)).toHaveLength(0);

      // a posting that appears later is new, so it is announced
      fresh.web.set(
        FEED_URL,
        feed.replace(
          '</channel>',
          '<item><title>Lead React Engineer at Globex</title><link>https://jobs.example.com/jobs/2002</link></item></channel>',
        ),
      );
      advance(fresh, 20);
      await fresh.collect();
      expect(await fresh.db.select().from(deliveries)).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
});

describe('card buttons', () => {
  const sentCard = async (title: string) => {
    await h.collect();
    await h.outbox.tick();
    const job = await jobByTitle(title);
    const [delivery] = await h.db.select().from(deliveries).where(eq(deliveries.jobId, job.id));
    return { job, messageId: delivery!.messageId! };
  };

  beforeEach(async () => {
    h = await createHarness(config(), START);
    serveAll(h);
  });

  it('adds an open posting to the tracker after checking it with the ATS', async () => {
    const { job, messageId } = await sentCard('Senior Frontend Engineer');
    h.web.set(greenhouseJobUrl('acmerobotics', '4000001'), '{"id":4000001}');

    await h.press(messageId, `t:${job.id}`);

    expect(h.web.requestsTo(greenhouseJobUrl('acmerobotics', '4000001'))).toBe(1);
    const [entry] = await h.db.select().from(trackerEntries);
    expect(entry).toMatchObject({
      jobId: job.id,
      title: 'Senior Frontend Engineer',
      company: 'Acme Robotics',
      url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001',
      source: 'greenhouse',
      salary: '€90k–120k / year',
      status: 'to_apply',
    });
    expect((await jobByTitle('Senior Frontend Engineer')).state).toBe('tracked');
    expect(h.lastText()).toContain('✅ Added to tracker');
    expect(h.sent('editMessageText').at(-1)!.payload.reply_markup).toBeUndefined();

    // pressing again changes nothing
    await h.press(messageId, `t:${job.id}`);
    expect(await h.db.select().from(trackerEntries)).toHaveLength(1);
  });

  it('refuses to add a posting that has been closed', async () => {
    const { job, messageId } = await sentCard('Senior Frontend Engineer');
    // the per-job endpoint is not served: Greenhouse answers 404 for a closed job

    await h.press(messageId, `t:${job.id}`);

    expect(await h.db.select().from(trackerEntries)).toHaveLength(0);
    expect(h.lastText()).toContain('⛔ Not added: the posting returned HTTP 404.');
    expect((await jobByTitle('Senior Frontend Engineer')).state).toBe('closed');
  });

  it('asks before adding when the check itself fails, and adds on confirmation', async () => {
    const { job, messageId } = await sentCard('Senior Full-Stack Engineer');
    h.web.set(ASHBY, { status: 503 });

    await h.press(messageId, `t:${job.id}`);
    expect(await h.db.select().from(trackerEntries)).toHaveLength(0);
    expect(h.lastText()).toContain('Could not verify that the posting is still open');
    expect(JSON.stringify(h.sent('editMessageText').at(-1)!.payload.reply_markup)).toContain(
      'Add anyway',
    );

    await h.press(messageId, `ta:${job.id}`);
    expect(await h.db.select().from(trackerEntries)).toHaveLength(1);
  });

  it('detects a closed Ashby posting from the board listing', async () => {
    const { job, messageId } = await sentCard('Senior Full-Stack Engineer');
    h.web.set(ASHBY, '{"jobs":[]}');
    await h.press(messageId, `t:${job.id}`);
    expect(h.lastText()).toContain('⛔ Not added: no longer listed on the Ashby board.');
  });

  it('rejects with a reason from the configured list', async () => {
    const { job, messageId } = await sentCard('Senior Frontend Engineer');

    await h.press(messageId, `r:${job.id}`);
    const keyboard = JSON.stringify(h.sent('editMessageText').at(-1)!.payload.reply_markup);
    for (const reason of h.config.telegram.reject_reasons) expect(keyboard).toContain(reason);

    await h.press(messageId, `rr:${job.id}:1`);
    expect(h.lastText()).toContain('❌ Rejected: Pay');
    expect(await h.db.select().from(feedback)).toMatchObject([
      { jobId: job.id, chatId: CHAT, action: 'reject', reason: 'Pay' },
    ]);
    expect((await jobByTitle('Senior Frontend Engineer')).state).toBe('rejected');
  });

  it('snoozes a card and sends it again when the time comes', async () => {
    const { job, messageId } = await sentCard('Senior Frontend Engineer');
    const before = h.sent().length;

    await h.press(messageId, `s:${job.id}`);
    await h.press(messageId, `ss:${job.id}:4`);
    expect(h.lastText()).toContain('💤 Snoozed until 5 Mar, 17:00');

    advance(h, 60);
    await h.outbox.tick();
    expect(h.sent()).toHaveLength(before);

    advance(h, 4 * 60);
    expect((await h.outbox.tick()).cards).toBe(1);
    expect(h.sent().at(-1)!.payload.text).toContain('Senior Frontend Engineer');
  });

  it('goes back from a sub-menu to the main buttons', async () => {
    const { job, messageId } = await sentCard('Senior Frontend Engineer');
    await h.press(messageId, `r:${job.id}`);
    await h.press(messageId, `b:${job.id}`);
    expect(JSON.stringify(h.sent('editMessageText').at(-1)!.payload.reply_markup)).toContain(
      'Add to tracker',
    );
    expect((await jobByTitle('Senior Frontend Engineer')).state).toBe('new');
  });
});

describe('batching, pausing and access', () => {
  it('sends one digest when more jobs are waiting than the threshold', async () => {
    h = await createHarness(
      config({ telegram: { allowed_chat_ids: [CHAT], batch_threshold: 2 } }),
      START,
    );
    serveAll(h);
    await h.collect();

    expect(await h.outbox.tick()).toEqual({ cards: 0, digests: 1, failed: 0 });
    expect(h.sent()).toHaveLength(1);
    const digest = h.lastText();
    expect(digest).toContain('3 new matching jobs');
    expect(digest).toContain('Senior Full-Stack Engineer');

    const job = await jobByTitle('Senior Full-Stack Engineer');
    expect(digest).toContain(`/job_${job.id}`);
    await h.say(`/job_${job.id}`);
    const card = h.sent().at(-1)!;
    expect(card.payload.text).toContain('Northwind Labs');
    expect(JSON.stringify(card.payload.reply_markup)).toContain(`t:${job.id}`);
  });

  it('collects and sends nothing while paused', async () => {
    h = await createHarness(config(), START);
    serveAll(h);
    await h.say('/pause');
    await h.collect();
    expect(h.web.requests).toHaveLength(0);

    await h.say('/resume');
    await h.collect();
    await h.say('/pause');
    expect(await h.outbox.tick()).toEqual({ cards: 0, digests: 0, failed: 0 });
    await h.say('/resume');
    expect((await h.outbox.tick()).cards).toBe(3);
  });

  it('tells a stranger their chat ID on /start and ignores everything else', async () => {
    h = await createHarness(config(), START);
    serveAll(h);
    await h.collect();

    await h.say('/start', 555);
    expect(h.lastText()).toContain('Your chat ID is <code>555</code>');
    const before = h.calls.length;
    await h.say('/status', 555);
    expect(h.calls).toHaveLength(before);

    const job = await jobByTitle('Senior Frontend Engineer');
    await h.press(101, `t:${job.id}`, 555);
    expect(h.calls.at(-1)).toMatchObject({ method: 'answerCallbackQuery' });
    expect(await h.db.select().from(trackerEntries)).toHaveLength(0);
  });

  it('answers /start, /help and /filters for an allowed chat', async () => {
    h = await createHarness(config(), START);
    await h.say('/start');
    expect(h.lastText()).toContain('matching jobs will arrive in this chat');
    await h.say('/help');
    expect(h.lastText()).toContain('never applies to jobs');
    await h.say('/filters');
    expect(h.lastText()).toContain('Max age: 7 days');
    expect(h.lastText()).toContain('Seniority wanted: senior, lead');
  });
});
