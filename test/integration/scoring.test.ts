import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveries, jobs, trackerEntries } from '../../src/db/schema.js';
import type { LlmClient } from '../../src/llm/client.js';
import { greenhouseBoardUrl, greenhouseJobUrl } from '../../src/sources/greenhouse.js';
import { fixture, testConfig } from '../helpers.js';
import { createHarness, type Harness } from './harness.js';

const GREENHOUSE = greenhouseBoardUrl('acmerobotics');

const llm: LlmClient = {
  generate: (request) =>
    Promise.resolve({
      output: {
        priority: request.prompt.includes('Frontend') ? 'P1' : 'P2',
        fit_score: request.prompt.includes('Frontend') ? 85 : 40,
        reason: 'Matches the React focus of the profile.',
        stack: ['React'],
        red_flags: [],
        industry: null,
      },
      refused: false,
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as never),
};

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('scored delivery', () => {
  it('sends the card only after scoring, shows the score and passes the priority to the tracker', async () => {
    const config = testConfig({
      sources: { greenhouse: { enabled: true, boards: ['acmerobotics'] } },
      scoring: {
        enabled: true,
        model: 'claude-sonnet-5-5',
        priorities: [
          { label: 'P1', definition: 'Frontend' },
          { label: 'P2', definition: 'Other' },
        ],
      },
    });
    h = await createHarness(config, '2026-03-05T12:00:00Z', { llm });
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json'));
    h.web.set(greenhouseJobUrl('acmerobotics', '4000001'), '{"id":4000001}');

    await h.collect();
    expect(await h.outbox.tick()).toEqual({ cards: 0, digests: 0, failed: 0 });

    await h.scorer!.process();
    expect((await h.outbox.tick()).cards).toBe(1);
    const card = String(h.sent().at(-1)!.payload.text);
    expect(card).toContain('🎯 <b>P1 · 85/100</b> · Matches the React focus of the profile.');
    expect(card).toContain('🧰 React');

    const [job] = await h.db.select().from(jobs).where(eq(jobs.title, 'Senior Frontend Engineer'));
    const [delivery] = await h.db.select().from(deliveries).where(eq(deliveries.jobId, job!.id));
    await h.press(delivery!.messageId!, `t:${job!.id}`);
    expect(await h.db.select().from(trackerEntries)).toMatchObject([
      { jobId: job!.id, priority: 'P1' },
    ]);

    await h.say('/status');
    expect(h.lastText()).toContain('<b>LLM:</b> $0.00 of $1.00 today (claude-sonnet-5-5)');
  });
});
