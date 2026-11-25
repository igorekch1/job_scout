import { pino, type Logger } from 'pino';

export type { Logger };

/** Keys that must never reach the logs, wherever they appear in a logged object. */
const REDACTED_PATHS = [
  'token',
  'botToken',
  'apiKey',
  'password',
  'authorization',
  'session',
  'databaseUrl',
  '*.token',
  '*.botToken',
  '*.apiKey',
  '*.password',
  '*.authorization',
  '*.session',
  '*.databaseUrl',
  'headers.authorization',
  'env',
];

const SECRET_IN_TEXT = [
  // Telegram bot tokens inside URLs or error messages
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  // credentials inside connection strings
  /(\w+:\/\/[^:/\s]+:)[^@\s]+@/g,
];

export function scrub(text: string): string {
  return text
    .replace(SECRET_IN_TEXT[0]!, '[redacted-token]')
    .replace(SECRET_IN_TEXT[1]!, '$1[redacted]@');
}

export function createLogger(name: string, level = 'info'): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL?.trim() || level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: (error: unknown) => {
        if (error instanceof Error) {
          return {
            type: error.name,
            message: scrub(error.message),
            stack: scrub(error.stack ?? ''),
          };
        }
        return { message: scrub(String(error)) };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const silentLogger: Logger = pino({ level: 'silent' });

export const errorMessage = (error: unknown): string =>
  scrub(error instanceof Error ? error.message : String(error));
