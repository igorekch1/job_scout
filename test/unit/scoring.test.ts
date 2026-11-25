import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/schema.js';
import type { Db } from '../../src/db/client.js';
import { deliveries, jobs, llmScores, llmUsage } from '../../src/db/schema.js';
import type { LlmClient, LlmRequest, LlmResult } from '../../src/llm/client.js';
import { costOf, pricingFor } from '../../src/llm/pricing.js';
import { silentLogger } from '../../src/logger.js';
import { ingestJob } from '../../src/pipeline/ingest.js';
import { jobPrompt, scoreSchema, scoringInstructions } from '../../src/scoring/prompt.js';
import { Scorer } from '../../src/scoring/scorer.js';
import { makeJob, testConfig } from '../helpers.js';
import { createTestDb } from '../integration/harness.js';

const NOW = new Date('2026-03-05T12:00:00Z');

const scoringConfig = (scoring: Record<string, unknown> = {}): Config =>
  testConfig({
    filters: { hours: { must_finish_by: '19:00' }, pay: { full_time_min_monthly: 5000 } },
    scoring: {
      enabled: true,
      model: 'claude-sonnet-5-5',
      daily_budget_usd: 1,
      priorities: [
        { label: 'P1', definition: 'Frontend on React' },
        { label: 'P2', definition: 'Full-stack with Node.js' },
      ],
      industries: ['FinTech', 'Other'],
      ...scoring,
    },
  });

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0 };

type Reply = Partial<LlmResult<Record<string, unknown>>> | Error;

/** Answers from a queue and records every request. */
function fakeLlm(replies: Reply[]): LlmClient & { requests: LlmRequest<never>[] } {
  const requests: LlmRequest<never>[] = [];
  return {
    requests,
    generate: (request) => {
      requests.push(request as LlmRequest<never>);
      const reply = replies.shift() ?? new Error('no reply queued');
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        output: null,
        refused: false,
        model: 'claude-sonnet-5-5',
        usage: USAGE,
        ...reply,
      } as never);
    },
  };
}

const GOOD = {
  priority: 'P1',
  fit_score: 86.6,
  reason: 'React and TypeScript frontend,\n fully remote in Europe.',
  stack: ['React', 'TypeScript'],
  red_flags: [{ kind: 'hours', note: 'Some overlap with US mornings.' }],
  industry: 'FinTech',
};

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

async function queueJob(config: Config, title = 'Senior Frontend Engineer'): Promise<number> {
  const outcome = await ingestJob(
    db,
    makeJob({ title, url: `https://jobs.example.com/${title}` }),
    {
      config,
      now: NOW,
      firstRun: false,
    },
  );
  if (outcome.kind !== 'created') throw new Error('job not created');
  return outcome.jobId;
}

const statuses = async () => (await db.select().from(deliveries)).map((row) => row.status);

function scorer(config: Config, llm: LlmClient, now = NOW) {
  return new Scorer({
    db,
    config,
    llm,
    pricing: pricingFor(config.scoring.model)!,
    profile: 'Senior frontend engineer. React, TypeScript, Node.js.',
    logger: silentLogger,
    now: () => now,
  });
}

describe('Scorer', () => {
  it('holds new jobs until scored, then stores the score, the spend and releases them', async () => {
    const config = scoringConfig();
    const jobId = await queueJob(config);
    expect(await statuses()).toEqual(['scoring']);

    const llm = fakeLlm([{ output: GOOD }]);
    expect(await scorer(config, llm).process()).toBe(1);

    expect(await statuses()).toEqual(['pending']);
    const [score] = await db.select().from(llmScores);
    expect(score).toMatchObject({
      jobId,
      priority: 'P1',
      fitScore: 87,
      reason: 'React and TypeScript frontend, fully remote in Europe.',
      stack: ['React', 'TypeScript'],
      redFlags: [{ kind: 'hours', note: 'Some overlap with US mornings.' }],
      industry: 'FinTech',
    });
    const [usage] = await db.select().from(llmUsage);
    // 1000 * $2 + 3000 * $0.10 + 200 * $10, per million tokens
    expect(usage).toMatchObject({ day: '2026-03-05', purpose: 'score', inputTokens: 1000 });
    expect(usage!.costUsd).toBeCloseTo(0.0043, 6);

    const request = llm.requests[0]!;
    expect(request.instructions).toContain('- P1: Frontend on React');
    expect(request.instructions).toContain('must finish work by 19:00');
    expect(request.context).toContain('<candidate_profile>');
    expect(request.prompt).toContain('Title: Senior Frontend Engineer');
  });

  it('does not send jobs below the minimum fit score', async () => {
    const config = scoringConfig({ min_fit_score: 90 });
    await queueJob(config);
    await scorer(config, fakeLlm([{ output: GOOD }])).process();
    expect(await statuses()).toEqual(['skipped']);
  });

  it('sends jobs unscored once the daily budget is spent, without calling the model', async () => {
    const config = scoringConfig({ daily_budget_usd: 0.004 });
    await queueJob(config, 'Senior Frontend Engineer');
    await queueJob(config, 'Lead React Engineer');
    const llm = fakeLlm([{ output: GOOD }, { output: GOOD }]);

    await scorer(config, llm).process();

    expect(llm.requests).toHaveLength(1);
    expect(await db.select().from(llmScores)).toHaveLength(1);
    expect(await statuses()).toEqual(['pending', 'pending']);

    // the budget is per calendar day in the user's time zone
    const nextDay = new Date('2026-03-06T12:00:00Z');
    await queueJob(config, 'Senior Vue Engineer');
    await scorer(config, fakeLlm([{ output: GOOD }]), nextDay).process();
    expect(await db.select().from(llmScores)).toHaveLength(2);
  });

  it('retries failed calls and gives up after three attempts', async () => {
    const config = scoringConfig();
    await queueJob(config);
    const instance = scorer(
      config,
      fakeLlm([new Error('overloaded'), new Error('overloaded'), new Error('overloaded')]),
    );

    await instance.process();
    await instance.process();
    expect(await statuses()).toEqual(['scoring']);
    await instance.process();
    expect(await statuses()).toEqual(['pending']);
    expect(await db.select().from(llmScores)).toHaveLength(0);
  });

  it('sends the job unscored when the model declines, and still records the spend', async () => {
    const config = scoringConfig();
    await queueJob(config);
    await scorer(config, fakeLlm([{ refused: true }])).process();
    expect(await statuses()).toEqual(['pending']);
    expect(await db.select().from(llmScores)).toHaveLength(0);
    expect(await db.select().from(llmUsage)).toHaveLength(1);
  });

  it('reuses a stored score instead of paying twice', async () => {
    const config = scoringConfig();
    const jobId = await queueJob(config);
    await scorer(config, fakeLlm([{ output: GOOD }])).process();
    await db.update(deliveries).set({ status: 'scoring' }).where(eq(deliveries.jobId, jobId));

    const llm = fakeLlm([]);
    await scorer(config, llm).process();
    expect(llm.requests).toHaveLength(0);
    expect(await statuses()).toEqual(['pending']);
  });

  it('queues jobs straight to sending when scoring is off', async () => {
    await queueJob(testConfig());
    expect(await statuses()).toEqual(['pending']);
  });
});

describe('scoring prompt and schema', () => {
  it('constrains priority and industry to the configured labels', () => {
    const schema = scoreSchema(scoringConfig());
    expect(schema.safeParse(GOOD).success).toBe(true);
    expect(schema.safeParse({ ...GOOD, priority: 'P7' }).success).toBe(false);
    expect(schema.safeParse({ ...GOOD, industry: 'Mining' }).success).toBe(false);
    expect(schema.safeParse({ ...GOOD, industry: null }).success).toBe(true);
    const noIndustries = scoreSchema(scoringConfig({ industries: [] }));
    expect(noIndustries.safeParse({ ...GOOD, industry: null }).success).toBe(true);
  });

  it('keeps the instructions stable and cuts long descriptions', async () => {
    const config = scoringConfig({ max_description_chars: 1000 });
    expect(scoringInstructions(config)).toBe(scoringInstructions(config));
    expect(scoringInstructions(config)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const jobId = await queueJob(config);
    await db
      .update(jobs)
      .set({ description: 'x'.repeat(5000) })
      .where(eq(jobs.id, jobId));
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    const prompt = jobPrompt(job!, config);
    expect(prompt).toContain('[description cut for length]');
    expect(prompt.length).toBeLessThan(1500);
  });
});

describe('pricing', () => {
  it('knows current models and accepts an override', () => {
    expect(pricingFor('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(pricingFor('some-future-model')).toBeUndefined();
    expect(pricingFor('some-future-model', { input: 1, output: 2 })).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
    });
  });

  it('charges cache writes at 1.25x and cache reads at the cache price', () => {
    const cost = costOf(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      { input: 4, output: 20, cacheRead: 0.2 },
    );
    expect(cost).toBeCloseTo(5.2, 6);
  });
});
