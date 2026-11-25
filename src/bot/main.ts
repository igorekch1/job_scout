import { loadBotEnv } from '../config/env.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { createDb } from '../db/client.js';
import { HttpClient } from '../http/client.js';
import { createLogger } from '../logger.js';
import { createTracker } from '../trackers/index.js';
import { userAgent } from '../version.js';
import { COMMANDS, createBot } from './bot.js';
import { Outbox } from './outbox.js';

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
  const bot = createBot({
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
    void bot
      .stop()
      .then(close)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await bot.api.setMyCommands([...COMMANDS]);
  outbox.start();
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
