import type { Config } from '../config/schema.js';
import { createAshbySource } from './ashby.js';
import { createGreenhouseSource } from './greenhouse.js';
import { createRssSource } from './rss.js';
import type { Source } from './types.js';

/** Source types present in the config schema that have no collector yet. */
const PLANNED = [
  'lever',
  'himalayas',
  'remotive',
  'remoteok',
  'jobicy',
  'telegram_channels',
] as const;

export interface SourceRegistry {
  sources: Source[];
  /** Source types the config enables but this version cannot run. */
  unsupported: string[];
}

/** Builds one Source per configured feed or board. */
export function buildSources(config: Config): SourceRegistry {
  const { sources: settings, schedule } = config;
  const interval = (own: number | undefined): number => own ?? schedule.default_interval_minutes;
  const sources: Source[] = [];

  if (settings.rss.enabled) {
    for (const feed of settings.rss.feeds) {
      sources.push(createRssSource(feed, interval(settings.rss.interval_minutes)));
    }
  }
  if (settings.greenhouse.enabled) {
    for (const board of new Set(settings.greenhouse.boards)) {
      sources.push(createGreenhouseSource(board, interval(settings.greenhouse.interval_minutes)));
    }
  }
  if (settings.ashby.enabled) {
    for (const board of new Set(settings.ashby.boards)) {
      sources.push(createAshbySource(board, interval(settings.ashby.interval_minutes)));
    }
  }

  return { sources, unsupported: PLANNED.filter((type) => settings[type].enabled) };
}
