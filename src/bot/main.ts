import { loadBotEnv } from '../config/env.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { createDb } from '../db/client.js';
import { HttpClient } from '../http/client.js';
import { createLogger } from '../logger.js';
import { createTracker } from '../trackers/index.js';
import { userAgent } from '../version.js';
import type { Config } from '../config/schema.js';
import { AnthropicLlm } from '../llm/client.js';
import { pricingFor } from '../llm/pricing.js';
import { loadProfile } from '../scoring/profile.js';
import { COMMANDS, createBot, type BotDeps } from './bot.js';
import { maybeSendDigest } from './digest.js';
import { Outbox } from './outbox.js';

function createDrafter(config: Config, apiKey: string | undefined): BotDeps['drafter'] {
  if (!config.application.enabled) return undefined;
  const app = config.application;
  const pricing = pricingFor(
    app.model,
    app.model === config.scoring.model ? config.scoring.pricing : undefined,
  );
  if (!pricing) {
    throw new ConfigError(
      `No built-in prices for model "${app.model}". Use a current Claude model for application.model.`,
    );
  }
  return {
    llm: new AnthropicLlm({ model: app.model, effort: app.effort, apiKey }),
    pricing,
    profile: loadProfile(app.profile_file),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const env = loadBotEnv();
  const logger = createLogger('bot', config.app.log_level);
  const { db, close } = createDb(env.DATABASE_URL);

  const http = new HttpClient({
    userAgent: userAgent(config.app.user_agent_contact),
    maxRetries: 1,
    logger: logger.child({ component: 'http' }),
  });
  const tracker = createTracker(config, db, { notionToken: env.NOTION_TOKEN });
  const health = await tracker.health?.();
  if (health && !health.ok) {
    logger.error({ tracker: tracker.id, problem: health.detail }, 'tracker check failed');
  } else if (health) {
    logger.info({ tracker: tracker.id }, health.detail);
  }
  const drafter = createDrafter(config, env.ANTHROPIC_API_KEY);
  const bot = createBot({
    drafter,
    token: env.TELEGRAM_BOT_TOKEN,
    db,
    config,
    tracker,
    http,
    logger,
  });
  const outbox = new Outbox({
    db,
    config,
    api: bot.api,
    logger: logger.child({ component: 'outbox' }),
  });

  if (config.telegram.allowed_chat_ids.length === 0) {
    logger.warn('telegram.allowed_chat_ids is empty: send /start to the bot to learn your chat ID');
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    outbox.stop();
    clearInterval(digestTimer);
    void bot
      .stop()
      .then(close)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.api.setMyCommands([...COMMANDS]);
  outbox.start();
  const digestDeps = { db, config, api: bot.api, logger };
  const digestTimer = setInterval(() => {
    maybeSendDigest(digestDeps, new Date()).catch((error: unknown) =>
      logger.error({ err: error }, 'daily digest failed'),
    );
  }, 60_000);
  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => logger.info({ username: me.username }, 'bot started'),
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    createLogger('bot').fatal({ err: error }, 'bot crashed');
  }
  process.exit(1);
});
