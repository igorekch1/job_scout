/** Validates a config file without starting anything: `pnpm config:check [path]`. */
import { ConfigError, loadConfig } from '../src/config/load.js';

try {
  const path = process.argv[2];
  const config = loadConfig(path);
  const enabled = Object.entries(config.sources)
    .filter(([, source]) => source.enabled)
    .map(([name]) => name);
  console.log(`Config is valid. Enabled sources: ${enabled.join(', ') || 'none'}.`);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
