import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Bot } from 'grammy';
import type { BotFullInfo, Update } from 'grammy/types';
import { createBot } from '../../src/bot/bot.js';
import { Outbox } from '../../src/bot/outbox.js';
import type { Config } from '../../src/config/schema.js';
import { MIGRATIONS_FOLDER, type Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import { HttpClient } from '../../src/http/client.js';
import { silentLogger } from '../../src/logger.js';
import { buildSources } from '../../src/sources/registry.js';
import { createTracker } from '../../src/trackers/index.js';
import type { LlmClient } from '../../src/llm/client.js';
import { Scorer } from '../../src/scoring/scorer.js';
import { Scheduler } from '../../src/worker/scheduler.js';

export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}

export type Route = string | { status: number; body?: string; headers?: Record<string, string> };

/** Stand-in for the network: answers from a URL table and records what was asked. */
export class FakeWeb {
  readonly requests: { url: string; headers: Record<string, string> }[] = [];
  private routes = new Map<string, Route>();

  set(url: string, route: Route): this {
    this.routes.set(url, route);
    return this;
  }

  readonly fetch = ((input: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    this.requests.push({ url: input, headers });
    const route = this.routes.get(input);
    if (route === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    if (typeof route !== 'string') {
      return Promise.resolve(
        new Response(route.body ?? '', { status: route.status, headers: route.headers }),
      );
    }
    // every body gets an ETag, like the real job board APIs
    const etag = `"${route.length}"`;
    if (headers['if-none-match'] === etag)
      return Promise.resolve(new Response(null, { status: 304 }));
    return Promise.resolve(new Response(route, { status: 200, headers: { etag } }));
  }) as unknown as typeof fetch;

  requestsTo(url: string): number {
    return this.requests.filter((request) => request.url === url).length;
  }
}

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as unknown as BotFullInfo;

/** Replaces the Telegram Bot API of a grammY bot with a recorder. Nothing leaves the process. */
export function mockTelegram(bot: Bot): ApiCall[] {
  const calls: ApiCall[] = [];
  let messageId = 100;
  bot.api.config.use((_prev, method, payload) => {
    const data = payload as Record<string, unknown>;
    calls.push({ method, payload: data });
    const result =
      method === 'sendMessage'
        ? {
            message_id: (messageId += 1),
            date: 0,
            chat: { id: data.chat_id, type: 'private' },
            text: data.text,
          }
        : true;
    return Promise.resolve({ ok: true, result } as never);
  });
  return calls;
}

let updateId = 0;
const user = (id: number) => ({ id, is_bot: false, first_name: 'Tester' });
const chat = (id: number) => ({ id, type: 'private' as const, first_name: 'Tester' });

export function messageUpdate(chatId: number, text: string): Update {
  const command = text.startsWith('/') ? text.split(/\s/)[0]! : null;
  return {
    update_id: (updateId += 1),
    message: {
      message_id: 1,
      date: 0,
      chat: chat(chatId),
      from: user(chatId),
      text,
      ...(command
        ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] }
        : {}),
    },
  };
}

export function buttonUpdate(chatId: number, messageId: number, data: string): Update {
  return {
    update_id: (updateId += 1),
    callback_query: {
      id: `cb-${updateId}`,
      from: user(chatId),
      chat_instance: 'test',
      data,
      message: { message_id: messageId, date: 0, chat: chat(chatId), text: 'card' },
    },
  };
}

export interface Harness {
  db: Db;
  config: Config;
  web: FakeWeb;
  calls: ApiCall[];
  bot: Bot;
  outbox: Outbox;
  scheduler: Scheduler;
  scorer: Scorer | undefined;
  clock: { now: Date };
  /** Runs every due source and waits for the runs to finish. */
  collect(): Promise<void>;
  press(messageId: number, data: string, chatId?: number): Promise<void>;
  say(text: string, chatId?: number): Promise<void>;
  sent(method?: string): ApiCall[];
  /** Waits for background work started by the bot (application drafts). */
  settle(): Promise<void>;
  lastText(): string;
  close(): Promise<void>;
}

export const CHAT = 1001;

export interface HarnessOptions {
  /** Answers requests to api.notion.com; enables the Notion tracker. */
  notionFetch?: typeof fetch;
  /** Fake LLM; creates a scorer when config.scoring.enabled, and a drafter when application.enabled. */
  llm?: LlmClient;
}

export async function createHarness(
  config: Config,
  startAt: string,
  options: HarnessOptions = {},
): Promise<Harness> {
  const { db, close } = await createTestDb();
  const web = new FakeWeb();
  const clock = { now: new Date(startAt) };
  const now = (): Date => clock.now;
  const noSleep = (): Promise<void> => Promise.resolve();

  const http = new HttpClient({
    userAgent: 'job-scout/test',
    fetch: web.fetch,
    sleep: noSleep,
    maxRetries: 0,
    minHostIntervalMs: 0,
  });
  const tasks: Promise<void>[] = [];
  const bot = createBot({
    background: (task) => tasks.push(task),
    drafter:
      options.llm && config.application.enabled
        ? {
            llm: options.llm,
            pricing: { input: 4, output: 20, cacheRead: 0.2 },
            profile: 'Senior frontend engineer. React and TypeScript. Based in the Netherlands.',
          }
        : undefined,
    token: 'test-token',
    db,
    config,
    tracker: createTracker(config, db, {
      notionToken: options.notionFetch ? 'secret_test' : undefined,
      fetch: options.notionFetch,
    }),
    http,
    logger: silentLogger,
    now,
    botInfo: BOT_INFO,
  });
  const calls = mockTelegram(bot);
  const outbox = new Outbox({
    db,
    config,
    api: bot.api,
    logger: silentLogger,
    now,
    sleep: noSleep,
    prepare: Boolean(options.llm && config.application.enabled),
  });
  const scheduler = new Scheduler(
    buildSources(config).sources,
    { db, config, http, logger: silentLogger, now },
    { maxConcurrent: config.schedule.max_concurrent_sources },
  );

  const scorer =
    options.llm && config.scoring.enabled
      ? new Scorer({
          db,
          config,
          llm: options.llm,
          pricing: { input: 2, output: 10, cacheRead: 0.1 },
          profile: 'Senior frontend engineer. React and TypeScript.',
          logger: silentLogger,
          now,
        })
      : undefined;

  const harness: Harness = {
    db,
    config,
    web,
    calls,
    bot,
    outbox,
    scheduler,
    scorer,
    clock,
    collect: async () => {
      for (let runs = await scheduler.tick(); runs.length > 0; runs = await scheduler.tick()) {
        await Promise.all(runs);
      }
    },
    press: (messageId, data, chatId = CHAT) =>
      bot.handleUpdate(buttonUpdate(chatId, messageId, data)),
    say: (text, chatId = CHAT) => bot.handleUpdate(messageUpdate(chatId, text)),
    settle: async () => {
      while (tasks.length > 0) await tasks.shift();
    },
    sent: (method = 'sendMessage') => calls.filter((call) => call.method === method),
    lastText: () => {
      const text = calls.filter((call) => 'text' in call.payload).at(-1)?.payload.text;
      return typeof text === 'string' ? text : '';
    },
    close,
  };
  return harness;
}

export const advance = (harness: Harness, minutes: number): void => {
  harness.clock.now = new Date(harness.clock.now.getTime() + minutes * 60_000);
};
