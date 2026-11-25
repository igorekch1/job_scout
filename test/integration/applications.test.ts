import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveries, jobs } from '../../src/db/schema.js';
import type { LlmClient, LlmRequest } from '../../src/llm/client.js';
import { greenhouseBoardUrl, greenhouseJobUrl } from '../../src/sources/greenhouse.js';
import { fixture, testConfig } from '../helpers.js';
import { createHarness, type Harness } from './harness.js';

const GREENHOUSE = greenhouseBoardUrl('acmerobotics');
const QUESTIONS_URL =
  'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs/4000001?questions=true';

const requests: LlmRequest<never>[] = [];
const llm: LlmClient = {
  generate: (request) => {
    requests.push(request as LlmRequest<never>);
    return Promise.resolve({
      output: {
        cover_letter: 'Short letter.',
        answers: [
          {
            question: 'Portfolio URL',
            answer: 'https://example.com/me',
            needs_input: false,
            note: '',
          },
        ],
      },
      refused: false,
      model: 'claude-opus-5-5',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as never);
  },
};

let h: Harness;
afterEach(async () => {
  await h?.close();
  requests.length = 0;
});

describe('Prepare application', () => {
  it('loads the Greenhouse questions, drafts in the background and sends the draft', async () => {
    const config = testConfig({
      sources: { greenhouse: { enabled: true, boards: ['acmerobotics'] } },
      application: { enabled: true },
    });
    h = await createHarness(config, '2026-03-05T12:00:00Z', { llm });
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json'));
    h.web.set(QUESTIONS_URL, fixture('greenhouse-job-questions.json'));
    h.web.set(greenhouseJobUrl('acmerobotics', '4000001'), '{"id":4000001}');
    await h.collect();
    await h.outbox.tick();

    const [job] = await h.db.select().from(jobs).where(eq(jobs.title, 'Senior Frontend Engineer'));
    const [delivery] = await h.db.select().from(deliveries).where(eq(deliveries.jobId, job!.id));
    const card = h
      .sent()
      .find((call) => String(call.payload.text).includes('Senior Frontend Engineer'))!;
    expect(JSON.stringify(card.payload.reply_markup)).toContain(`p:${job!.id}`);

    await h.press(delivery!.messageId!, `p:${job!.id}`);
    expect(h.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      payload: { text: 'Preparing the application draft…' },
    });
    await h.settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain('Why do you want to work on warehouse robots?');
    expect(h.lastText()).toContain(
      '📝 <b>Application draft</b>: Senior Frontend Engineer at Acme Robotics',
    );
    expect(h.lastText()).toContain('<pre>https://example.com/me</pre>');

    // still available after the job is tracked
    await h.press(delivery!.messageId!, `t:${job!.id}`);
    const edited = h.sent('editMessageText').at(-1)!;
    expect(JSON.stringify(edited.payload.reply_markup)).toContain(`p:${job!.id}`);
    await h.press(delivery!.messageId!, `p:${job!.id}`);
    await h.settle();
    expect(requests).toHaveLength(1); // the stored draft is reused
  });

  it('hides the button when drafting is off', async () => {
    const config = testConfig({
      sources: { greenhouse: { enabled: true, boards: ['acmerobotics'] } },
    });
    h = await createHarness(config, '2026-03-05T12:00:00Z');
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json'));
    await h.collect();
    await h.outbox.tick();
    expect(JSON.stringify(h.sent()[0]!.payload.reply_markup)).not.toContain('"p:');
  });
});
