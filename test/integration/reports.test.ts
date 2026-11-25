import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { maybeSendDigest } from '../../src/bot/digest.js';
import { deliveries, jobs } from '../../src/db/schema.js';
import { silentLogger } from '../../src/logger.js';
import { ashbyBoardUrl } from '../../src/sources/ashby.js';
import { greenhouseBoardUrl } from '../../src/sources/greenhouse.js';
import { fixture, testConfig } from '../helpers.js';
import { advance, CHAT, createHarness, type Harness } from './harness.js';

const GREENHOUSE = greenhouseBoardUrl('acmerobotics');
const ASHBY = ashbyBoardUrl('northwind-labs');

const config = (overrides: Record<string, unknown> = {}) =>
  testConfig({
    schedule: { max_concurrent_sources: 1 },
    sources: {
      greenhouse: { enabled: true, boards: ['acmerobotics'] },
      ashby: { enabled: true, boards: ['northwind-labs'] },
    },
    filters: { title: { exclude_any: ['designer'] } },
    ...overrides,
  });

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function collected(overrides: Record<string, unknown> = {}): Promise<Harness> {
  // 13:00 in Amsterdam
  const harness = await createHarness(config(overrides), '2026-03-05T12:00:00Z');
  harness.web
    .set(GREENHOUSE, fixture('greenhouse-board.json'))
    .set(ASHBY, fixture('ashby-board.json'));
  await harness.collect();
  return harness;
}

describe('/digest', () => {
  it('summarises the last 24 hours with top picks and failing sources', async () => {
    h = await createHarness(config(), '2026-03-05T12:00:00Z');
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json')).set(ASHBY, { status: 500 });
    await h.collect();

    await h.say('/digest');
    const text = h.lastText();
    expect(text).toContain('<b>Digest for the last 24 hours</b>');
    expect(text).toContain('2 found · 1 kept · 1 dropped');
    expect(text).toContain('<b>Top picks</b> (1 of 1 waiting)');
    expect(text).toContain('Senior Frontend Engineer');
    const [job] = await h.db.select().from(jobs).where(eq(jobs.title, 'Senior Frontend Engineer'));
    expect(text).toContain(`/job_${job!.id}`);
    expect(text).toContain('❌ ashby:northwind-labs: HTTP 500 from api.ashbyhq.com (1×)');
  });
});

describe('scheduled digest', () => {
  it('sends once per day at the configured local time', async () => {
    h = await collected({
      telegram: { allowed_chat_ids: [CHAT], digest: { enabled: true, time: '14:00' } },
    });
    const deps = { db: h.db, config: h.config, api: h.bot.api, logger: silentLogger };

    expect(await maybeSendDigest(deps, h.clock.now)).toBe(false); // 13:00 local
    advance(h, 60);
    expect(await maybeSendDigest(deps, h.clock.now)).toBe(true); // 14:00 local
    expect(h.lastText()).toContain('Digest for the last 24 hours');
    advance(h, 120);
    expect(await maybeSendDigest(deps, h.clock.now)).toBe(false); // already sent today
    advance(h, 24 * 60);
    expect(await maybeSendDigest(deps, h.clock.now)).toBe(true); // next day
  });

  it('does nothing when switched off', async () => {
    h = await collected();
    const deps = { db: h.db, config: h.config, api: h.bot.api, logger: silentLogger };
    advance(h, 12 * 60);
    expect(await maybeSendDigest(deps, h.clock.now)).toBe(false);
  });
});

describe('/stats', () => {
  it('counts jobs, drop reasons and reject reasons', async () => {
    h = await collected();
    await h.outbox.tick();
    const [job] = await h.db.select().from(jobs).where(eq(jobs.title, 'Senior Frontend Engineer'));
    const [delivery] = await h.db.select().from(deliveries).where(eq(deliveries.jobId, job!.id));
    await h.press(delivery!.messageId!, `rr:${job!.id}:1`);

    await h.say('/stats');
    const text = h.lastText();
    expect(text).toMatch(/Found\s+4\s+4/);
    expect(text).toMatch(/Rejected\s+1\s+1/);
    expect(text).toContain('Main drop reasons');
    expect(text).toContain('Title has an excluded keyword');
    expect(text).toContain('<b>Your reject reasons</b>\n1 · Pay');
  });
});

describe('/search', () => {
  it('finds stored jobs by every word and marks their state', async () => {
    h = await collected();
    await h.say('/search frontend acme');
    let text = h.lastText();
    expect(text).toContain('<b>Search:</b> frontend acme (1)');
    expect(text).toContain('🆕 <b>Senior Frontend Engineer</b>');

    await h.say('/search designer');
    expect(h.lastText()).toContain('🚫 <b>Product Designer</b>');

    await h.say('/search warehouse robots');
    text = h.lastText();
    expect(text).toContain('Senior Frontend Engineer</b>');
    expect(text).toContain('(in description)');

    await h.say('/search 100%_off');
    expect(h.lastText()).toContain('Nothing found');
    await h.say('/search');
    expect(h.lastText()).toContain('Usage: /search');
  });
});

describe('/sources', () => {
  it('turns a source off and on, and the scheduler respects it', async () => {
    h = await createHarness(config(), '2026-03-05T12:00:00Z');
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json')).set(ASHBY, fixture('ashby-board.json'));

    await h.say('/sources');
    const keyboard = JSON.stringify(h.calls.at(-1)!.payload.reply_markup);
    expect(keyboard).toContain('🟢 greenhouse:acmerobotics');
    expect(keyboard).toContain('"callback_data":"src:1"');

    await h.press(500, 'src:1'); // ashby:northwind-labs
    expect(JSON.stringify(h.sent('editMessageText').at(-1)!.payload.reply_markup)).toContain(
      '⚪️ ashby:northwind-labs',
    );
    await h.collect();
    expect(h.web.requestsTo(ASHBY)).toBe(0);
    expect(h.web.requestsTo(GREENHOUSE)).toBe(1);

    await h.say('/status');
    expect(h.lastText()).toContain('⚪️ ashby:northwind-labs: off (/sources)');

    await h.press(500, 'src:1');
    await h.collect();
    expect(h.web.requestsTo(ASHBY)).toBe(1);
  });
});
