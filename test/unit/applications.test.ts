import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareDraft, draftInstructions, draftPrompt } from '../../src/applications/draft.js';
import { mapGreenhouseQuestions, type QuestionSet } from '../../src/applications/questions.js';
import { renderDraft } from '../../src/bot/cards.js';
import type { Config } from '../../src/config/schema.js';
import type { Db } from '../../src/db/client.js';
import { applicationDrafts, jobs, llmUsage } from '../../src/db/schema.js';
import type { LlmClient, LlmRequest } from '../../src/llm/client.js';
import { ingestJob } from '../../src/pipeline/ingest.js';
import { jsonFixture, makeJob, testConfig } from '../helpers.js';
import { createTestDb } from '../integration/harness.js';

const NOW = new Date('2026-03-05T12:00:00Z');

describe('mapGreenhouseQuestions', () => {
  it('keeps custom questions and leaves personal and demographic ones to the user', () => {
    const set = mapGreenhouseQuestions(jsonFixture('greenhouse-job-questions.json'));
    expect(set.origin).toBe('greenhouse');
    expect(set.questions).toEqual([
      { label: 'Portfolio URL', required: false, kind: 'text', options: [] },
      {
        label: 'Why do you want to work on warehouse robots?',
        required: true,
        kind: 'long_text',
        options: [],
      },
      {
        label: 'Will you now or in the future require visa sponsorship?',
        required: true,
        kind: 'single_select',
        options: ['Yes', 'No'],
      },
      {
        label: 'Which frameworks have you used?',
        required: false,
        kind: 'multi_select',
        options: ['React', 'Vue'],
      },
    ]);
    expect(set.skipped).toEqual([
      'First Name',
      'Email',
      'Resume/CV',
      'Equal-opportunity and demographic questions',
    ]);
  });

  it('returns an empty set for an unexpected payload', () => {
    expect(mapGreenhouseQuestions({ nope: true })).toEqual({
      questions: [],
      skipped: [],
      origin: 'greenhouse',
    });
  });
});

const OUTPUT = {
  cover_letter: 'I build React interfaces for operations teams.',
  answers: [
    {
      question: 'Portfolio URL',
      answer: 'https://example.com/portfolio',
      needs_input: false,
      note: '',
    },
    {
      question: 'Why do you want to work on warehouse robots?',
      answer: 'I like tools people use all day.',
      needs_input: false,
      note: '',
    },
    {
      question: 'Will you now or in the future require visa sponsorship?',
      answer: '',
      needs_input: true,
      note: 'Your profile does not state your work authorisation.',
    },
  ],
};

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  await close();
});

function fakeLlm(output: unknown, refused = false): LlmClient & { requests: LlmRequest<never>[] } {
  const requests: LlmRequest<never>[] = [];
  return {
    requests,
    generate: (request) => {
      requests.push(request as LlmRequest<never>);
      return Promise.resolve({
        output: refused ? null : output,
        refused,
        model: 'claude-opus-5-5',
        usage: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as never);
    },
  };
}

const config = (overrides: Record<string, unknown> = {}): Config =>
  testConfig({
    application: {
      enabled: true,
      style_rules: ['Never use em dashes'],
      cover_letter_max_words: 150,
    },
    ...overrides,
  });

async function storedJob(cfg: Config) {
  const outcome = await ingestJob(db, makeJob(), { config: cfg, now: NOW, firstRun: false });
  if (outcome.kind !== 'created') throw new Error('not created');
  const [job] = await db.select().from(jobs);
  return job!;
}

const QUESTIONS: QuestionSet = mapGreenhouseQuestions(jsonFixture('greenhouse-job-questions.json'));
const deps = (cfg: Config, llm: LlmClient) => ({
  db,
  config: cfg,
  llm,
  pricing: { input: 4, output: 20, cacheRead: 0.2 },
  profile: 'Senior frontend engineer. React, TypeScript.',
  now: () => NOW,
});

describe('prepareDraft', () => {
  it('generates, stores and reuses a draft, and records the spend', async () => {
    const cfg = config();
    const job = await storedJob(cfg);
    const llm = fakeLlm(OUTPUT);

    const first = await prepareDraft(deps(cfg, llm), job, QUESTIONS);
    expect(first.kind).toBe('draft');
    if (first.kind !== 'draft') return;
    expect(first.cached).toBe(false);
    expect(first.draft.answers).toEqual([
      {
        question: 'Portfolio URL',
        required: false,
        answer: 'https://example.com/portfolio',
        needsInput: false,
        note: '',
      },
      {
        question: 'Why do you want to work on warehouse robots?',
        required: true,
        answer: 'I like tools people use all day.',
        needsInput: false,
        note: '',
      },
      {
        question: 'Will you now or in the future require visa sponsorship?',
        required: true,
        answer: '',
        needsInput: true,
        note: 'Your profile does not state your work authorisation.',
      },
    ]);
    expect(first.draft.skipped).toContain('Equal-opportunity and demographic questions');
    const [usage] = await db.select().from(llmUsage);
    expect(usage).toMatchObject({ purpose: 'application' });

    const request = llm.requests[0]!;
    expect(request.instructions).toContain('Use only facts stated in the candidate profile');
    expect(request.instructions).toContain('At most 150 words');
    expect(request.instructions).toContain('- Never use em dashes');
    expect(request.prompt).toContain(
      '3. Will you now or in the future require visa sponsorship? [single_select, required] Options: Yes | No',
    );
    expect(request.effort).toBe('medium');

    const again = await prepareDraft(deps(cfg, llm), job, QUESTIONS);
    expect(again).toMatchObject({ kind: 'draft', cached: true });
    expect(llm.requests).toHaveLength(1);
  });

  it('refuses when the daily budget is spent', async () => {
    const cfg = config({ scoring: { daily_budget_usd: 0 } });
    const job = await storedJob(cfg);
    const llm = fakeLlm(OUTPUT);
    expect(await prepareDraft(deps(cfg, llm), job, QUESTIONS)).toEqual({
      kind: 'budget',
      spent: 0,
    });
    expect(llm.requests).toHaveLength(0);
  });

  it('reports a declined request and stores nothing', async () => {
    const cfg = config();
    const job = await storedJob(cfg);
    expect(await prepareDraft(deps(cfg, fakeLlm(null, true)), job, QUESTIONS)).toEqual({
      kind: 'declined',
    });
    expect(await db.select().from(applicationDrafts)).toHaveLength(0);
  });

  it('asks only for a cover letter when the posting has no questions', async () => {
    const cfg = config();
    const job = await storedJob(cfg);
    expect(draftPrompt(job, { questions: [], skipped: [], origin: null }, 20000)).toContain(
      'No application questions are available',
    );
    expect(draftInstructions(cfg)).toContain('Write in this language: en.');
  });
});

describe('renderDraft', () => {
  it('puts each answer in a copyable block and marks what needs input', async () => {
    const cfg = config();
    const job = await storedJob(cfg);
    const result = await prepareDraft(deps(cfg, fakeLlm(OUTPUT)), job, QUESTIONS);
    if (result.kind !== 'draft') throw new Error('no draft');
    const [message, ...rest] = renderDraft(job, result.draft);
    expect(rest).toEqual([]);
    expect(message).toContain(
      '<b>Cover letter</b>\n<pre>I build React interfaces for operations teams.</pre>',
    );
    expect(message).toContain('<b>1. Portfolio URL</b>\n<pre>https://example.com/portfolio</pre>');
    expect(message).toContain(
      '<b>3. Will you now or in the future require visa sponsorship?</b> (required)\n✏️ Your profile does not state',
    );
    expect(message).toContain(
      '<i>Fill in yourself: First Name; Email; Resume/CV; Equal-opportunity and demographic questions</i>',
    );
  });

  it('splits long drafts across messages under the Telegram limit', async () => {
    const cfg = config();
    const job = await storedJob(cfg);
    const long = {
      cover_letter: 'x'.repeat(3000),
      answers: Array.from({ length: 5 }, (_, index) => ({
        question: `Question ${index}`,
        answer: 'y'.repeat(1500),
        needs_input: false,
        note: '',
      })),
    };
    const result = await prepareDraft(deps(cfg, fakeLlm(long)), job, {
      questions: [],
      skipped: [],
      origin: null,
    });
    if (result.kind !== 'draft') throw new Error('no draft');
    const messages = renderDraft(job, result.draft);
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((text) => text.length <= 4096)).toBe(true);
  });
});
