import { loadWorkerEnv } from '../config/env.js';
import { ConfigError, loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { createDb } from '../db/client.js';
import { HttpClient } from '../http/client.js';
import { createLogger } from '../logger.js';
import { buildSources } from '../sources/registry.js';
import { userAgent } from '../version.js';
import { AnthropicLlm } from '../llm/client.js';
import { pricingFor } from '../llm/pricing.js';
import { loadProfile } from '../scoring/profile.js';
import { Scorer } from '../scoring/scorer.js';
import { Scheduler } from './scheduler.js';

function createScorer(
  config: Config,
  db: Db,
  apiKey: string | undefined,
  logger: Logger,
): Scorer | undefined {
  if (!config.scoring.enabled) return undefined;
  const pricing = pricingFor(config.scoring.model, config.scoring.pricing);
  if (!pricing) {
    throw new ConfigError(
      `No built-in prices for model "${config.scoring.model}". Set scoring.pricing so the daily budget can be enforced.`,
    );
  }
  const profile = loadProfile(config.application.profile_file);
  const llm = new AnthropicLlm({
    model: config.scoring.model,
    effort: config.scoring.effort,
    apiKey,
  });
  logger.info(
    { model: config.scoring.model, budgetUsd: config.scoring.daily_budget_usd },
    'LLM scoring on',
  );
  return new Scorer({
    db,
    config,
    llm,
    pricing,
    profile,
    logger: logger.child({ component: 'scorer' }),
  });
}

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
  const scorer = createScorer(config, db, env.ANTHROPIC_API_KEY, logger);
  const scoringTimer = scorer ? setInterval(() => void scorer.process(), 5_000) : undefined;

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
    if (scoringTimer) clearInterval(scoringTimer);
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
