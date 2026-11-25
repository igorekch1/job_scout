import { z } from 'zod';
import { ConfigError, formatIssues } from './load.js';

const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

const baseEnv = z.object({
  DATABASE_URL: z
    .string({ error: 'is required (a postgres:// connection string)' })
    .trim()
    .min(1, 'is required (a postgres:// connection string)'),
  LOG_LEVEL: optionalSecret,
  ANTHROPIC_API_KEY: optionalSecret,
  NOTION_TOKEN: optionalSecret,
  TG_API_ID: optionalSecret.refine(
    (value) => value === undefined || /^\d+$/.test(value),
    'must be the numeric api_id from my.telegram.org',
  ),
  TG_API_HASH: optionalSecret,
  TG_SESSION: optionalSecret,
});

const botEnv = baseEnv.extend({
  TELEGRAM_BOT_TOKEN: z
    .string({ error: 'is required (create a bot with @BotFather)' })
    .trim()
    .min(1, 'is required (create a bot with @BotFather)'),
});

export type WorkerEnv = z.infer<typeof baseEnv>;
export type BotEnv = z.infer<typeof botEnv>;

function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError('Environment is invalid:', formatIssues(result.error));
  }
  return result.data;
}

export const loadWorkerEnv = (source: NodeJS.ProcessEnv = process.env): WorkerEnv =>
  parseEnv(baseEnv, source);

export const loadBotEnv = (source: NodeJS.ProcessEnv = process.env): BotEnv =>
  parseEnv(botEnv, source);
