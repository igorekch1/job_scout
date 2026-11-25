import { loadWorkerEnv } from '../config/env.js';
import { ConfigError, loadConfig } from '../config/load.js';
import { createDb } from '../db/client.js';
import { HttpClient } from '../http/client.js';
import { createLogger } from '../logger.js';
import { buildSources } from '../sources/registry.js';
import { userAgent } from '../version.js';
import { Scheduler } from './scheduler.js';

function main(): void {
  const config = loadConfig();
  const env = loadWorkerEnv();
  const logger = createLogger('worker', config.app.log_level);
  const { db, close } = createDb(env.DATABASE_URL);

  const { sources, unsupported } = buildSources(config);
  for (const type of unsupported) {
    logger.warn({ source: type }, 'source is enabled in config but not implemented yet; skipping');
  }
  if (sources.length === 0) {
    logger.warn('no sources are enabled; enable at least one under `sources` in config.yaml');
  }
  if (config.telegram.allowed_chat_ids.length === 0) {
    logger.warn('telegram.allowed_chat_ids is empty: jobs are collected but nobody is notified');
  }

  const http = new HttpClient({
    userAgent: userAgent(config.app.user_agent_contact),
    logger: logger.child({ component: 'http' }),
  });
  const scheduler = new Scheduler(
    sources,
    { db, config, http, logger },
    { maxConcurrent: config.schedule.max_concurrent_sources },
  );
  scheduler.start();
  logger.info({ sources: sources.map((source) => source.id) }, 'worker started');

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    void scheduler
      .stop()
      .then(close)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    createLogger('worker').fatal({ err: error }, 'worker crashed');
  }
  process.exit(1);
}
