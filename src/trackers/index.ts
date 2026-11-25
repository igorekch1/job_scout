import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { PostgresTracker } from './postgres.js';
import type { Tracker } from './types.js';

export type { Tracker, TrackerEntry, TrackerResult } from './types.js';

export function createTracker(config: Config, db: Db): Tracker {
  switch (config.tracker.type) {
    case 'postgres':
      return new PostgresTracker(db);
    case 'notion':
      throw new Error('The Notion tracker is not implemented yet. Set tracker.type to "postgres".');
  }
}
