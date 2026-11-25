import { loadWorkerEnv } from '../config/env.js';
import { ConfigError } from '../config/load.js';
import { createLogger, errorMessage } from '../logger.js';
import { runMigrations } from './client.js';

const log = createLogger('migrate');

try {
  const env = loadWorkerEnv();
  await runMigrations(env.DATABASE_URL);
  log.info('migrations applied');
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    log.error({ err: error }, `migration failed: ${errorMessage(error)}`);
  }
  process.exit(1);
}
