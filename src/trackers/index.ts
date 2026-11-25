import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { NotionTracker } from './notion/tracker.js';
import { PostgresTracker } from './postgres.js';
import type { Tracker } from './types.js';

export type { Tracker, TrackerEntry, TrackerHealth, TrackerResult } from './types.js';

export interface TrackerSecrets {
  notionToken?: string;
  fetch?: typeof fetch;
}

export function createTracker(config: Config, db: Db, secrets: TrackerSecrets = {}): Tracker {
  switch (config.tracker.type) {
    case 'postgres':
      return new PostgresTracker(db);
    case 'notion':
      if (!secrets.notionToken) {
        throw new Error('NOTION_TOKEN is required when tracker.type is "notion"');
      }
      return NotionTracker.create(config, secrets.notionToken, secrets.fetch);
  }
}
