import type { Config } from '../config/schema.js';
import { createAshbySource } from './ashby.js';
import { createGreenhouseSource } from './greenhouse.js';
import { createLeverSource } from './lever.js';
import {
  createHimalayasSource,
  createJobicySource,
  createRemoteOkSource,
  createRemotiveSource,
} from './remote-boards.js';
import { createRssSource } from './rss.js';
import type { ChannelReader } from './telegram/reader.js';
import { createTelegramChannelSource, normalizeChannel } from './telegram/source.js';
import type { Source } from './types.js';

/** Source types present in the config schema that have no collector yet. */
const PLANNED: readonly (keyof Config['sources'])[] = [];

/**
 * Lower bounds on polling intervals, from each provider's published guidance. A shorter
 * interval in config is raised to these.
 */
export const MIN_INTERVAL_MINUTES: Readonly<Record<string, number>> = {
  remotive: 6 * 60,
  jobicy: 60,
  himalayas: 60,
  remoteok: 60,
};

export interface SourceRegistry {
  sources: Source[];
  /** Source types the config enables but this version cannot run. */
  unsupported: string[];
}

/** Builds one Source per configured feed or board. */
export interface BuildOptions {
  /** Reader for Telegram channels; without it those sources fail with a clear message. */
  telegramReader?: ChannelReader;
}

const missingReader: ChannelReader = {
  read: () =>
    Promise.reject(new Error('Telegram channel reader is not configured in this process')),
  close: () => Promise.resolve(),
};

export function buildSources(config: Config, options: BuildOptions = {}): SourceRegistry {
  const { sources: settings, schedule } = config;
  const interval = (own: number | undefined, type?: string): number =>
    Math.max(own ?? schedule.default_interval_minutes, MIN_INTERVAL_MINUTES[type ?? ''] ?? 1);
  const sources: Source[] = [];

  // Employer ATS boards first: when everything is due at once, their link becomes the primary one.
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

  if (settings.rss.enabled) {
    for (const feed of settings.rss.feeds) {
      sources.push(createRssSource(feed, interval(settings.rss.interval_minutes)));
    }
  }

  if (settings.lever.enabled) {
    for (const site of new Set(settings.lever.companies)) {
      sources.push(createLeverSource(site, interval(settings.lever.interval_minutes)));
    }
    for (const site of new Set(settings.lever.eu_companies)) {
      sources.push(createLeverSource(site, interval(settings.lever.interval_minutes), true));
    }
  }
  if (settings.himalayas.enabled) {
    sources.push(
      createHimalayasSource(
        settings.himalayas,
        interval(settings.himalayas.interval_minutes, 'himalayas'),
      ),
    );
  }
  if (settings.remotive.enabled) {
    sources.push(
      createRemotiveSource(
        settings.remotive,
        interval(settings.remotive.interval_minutes, 'remotive'),
      ),
    );
  }
  if (settings.remoteok.enabled) {
    sources.push(
      createRemoteOkSource(
        settings.remoteok,
        interval(settings.remoteok.interval_minutes, 'remoteok'),
      ),
    );
  }
  if (settings.jobicy.enabled) {
    sources.push(
      createJobicySource(settings.jobicy, interval(settings.jobicy.interval_minutes, 'jobicy')),
    );
  }

  if (settings.telegram_channels.enabled) {
    const reader = options.telegramReader ?? missingReader;
    const channels = new Set(settings.telegram_channels.channels.map(normalizeChannel));
    for (const channel of channels) {
      sources.push(
        createTelegramChannelSource(
          channel,
          reader,
          interval(settings.telegram_channels.interval_minutes),
          settings.telegram_channels.posts_per_run,
        ),
      );
    }
  }

  return { sources, unsupported: PLANNED.filter((type) => settings[type].enabled) };
}
