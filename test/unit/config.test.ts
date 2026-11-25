import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadBotEnv, loadWorkerEnv } from '../../src/config/env.js';
import { ConfigError, parseConfig, parseConfigYaml } from '../../src/config/load.js';

const minimal = { user: { timezone: 'Europe/Amsterdam', country: 'nl' } };

const errorOf = (fn: () => unknown): ConfigError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
};

describe('config', () => {
  it('accepts the committed example file', () => {
    const config = parseConfigYaml(readFileSync('config.example.yaml', 'utf8'));
    expect(config.sources.rss.feeds).toHaveLength(1);
    expect(config.filters.pay.fx_rates.EUR).toBe(1.1);
    expect(config.tracker.type).toBe('postgres');
  });

  it('fills defaults from a minimal config', () => {
    const config = parseConfig(minimal);
    expect(config.user.country).toBe('NL');
    expect(config.schedule.default_interval_minutes).toBe(15);
    expect(config.sources.greenhouse.enabled).toBe(false);
    expect(config.telegram.batch_threshold).toBe(5);
    expect(config.filters.location.require_user_country_when_restricted).toBe(true);
    expect(config.filters.max_age_days).toBeUndefined();
  });

  it('reports the path of an invalid value', () => {
    const error = errorOf(() =>
      parseConfig({ ...minimal, filters: { pay: { fx_rates: { EUR: 'a lot' } } } }),
    );
    expect(error.issues.join('\n')).toMatch(/^filters\.pay\.fx_rates\.EUR: /m);
  });

  it('reports unknown keys instead of ignoring typos', () => {
    const error = errorOf(() => parseConfig({ ...minimal, telegram: { batch_treshold: 3 } }));
    expect(error.issues).toContain('telegram: unknown key "batch_treshold"');
  });

  it('rejects an unknown time zone, a bad time and a bad regex', () => {
    const error = errorOf(() =>
      parseConfig({
        user: { timezone: 'Mars/Olympus', country: 'NL' },
        filters: { hours: { must_finish_by: '7pm', drop_patterns: ['('] } },
      }),
    );
    const text = error.issues.join('\n');
    expect(text).toContain('user.timezone: unknown IANA time zone');
    expect(text).toContain('filters.hours.must_finish_by: expected a 24-hour time');
    expect(text).toContain('filters.hours.drop_patterns[0]: invalid regular expression');
  });

  it('rejects duplicate feed ids', () => {
    const feed = { id: 'board', url: 'https://jobs.example.com/feed.rss' };
    const error = errorOf(() =>
      parseConfig({ ...minimal, sources: { rss: { feeds: [feed, feed] } } }),
    );
    expect(error.issues).toContain('sources.rss.feeds[1].id: duplicate feed id "board"');
  });

  it('requires notion settings when the notion tracker is selected', () => {
    const error = errorOf(() => parseConfig({ ...minimal, tracker: { type: 'notion' } }));
    expect(error.issues).toContain('tracker.notion: required when tracker.type is "notion"');
  });

  it('explains empty and malformed files', () => {
    expect(errorOf(() => parseConfigYaml('')).message).toContain('is empty');
    expect(errorOf(() => parseConfigYaml('user: [unclosed')).message).toContain('not valid YAML');
  });
});

describe('env', () => {
  it('requires the database URL for the worker and the token for the bot', () => {
    expect(errorOf(() => loadWorkerEnv({})).issues.join('\n')).toContain(
      'DATABASE_URL: is required',
    );
    const error = errorOf(() => loadBotEnv({ DATABASE_URL: 'postgres://u:p@localhost/db' }));
    expect(error.issues.join('\n')).toContain('TELEGRAM_BOT_TOKEN: is required');
  });

  it('treats blank optional secrets as unset', () => {
    const env = loadWorkerEnv({ DATABASE_URL: 'postgres://u:p@localhost/db', NOTION_TOKEN: '  ' });
    expect(env.NOTION_TOKEN).toBeUndefined();
  });
});
