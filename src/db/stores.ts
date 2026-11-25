import { eq, sql } from 'drizzle-orm';
import type { Validators } from '../http/client.js';
import type { ValidatorStore } from '../http/session.js';
import type { Db } from './client.js';
import { httpCache, settings, sourceState, type SourceStateRow } from './schema.js';

/** ETag / Last-Modified validators persisted in `http_cache`. */
export class DbValidatorStore implements ValidatorStore {
  constructor(private readonly db: Db) {}

  async get(url: string): Promise<Validators | undefined> {
    const [row] = await this.db.select().from(httpCache).where(eq(httpCache.url, url)).limit(1);
    return row ? { etag: row.etag, lastModified: row.lastModified } : undefined;
  }

  async set(url: string, validators: Validators): Promise<void> {
    const values = {
      url,
      etag: validators.etag ?? null,
      lastModified: validators.lastModified ?? null,
      updatedAt: new Date(),
    };
    await this.db
      .insert(httpCache)
      .values(values)
      .onConflictDoUpdate({ target: httpCache.url, set: values });
  }
}

/* ----------------------------------------------------------------- settings */

export const SETTING_PAUSED = 'paused';
export const SETTING_WORKER_HEARTBEAT = 'worker_heartbeat';
export const SETTING_DISABLED_SOURCES = 'disabled_sources';
export const SETTING_DIGEST_SENT_DAY = 'digest_sent_day';

/** Source ids switched off with /sources. */
export const getDisabledSources = async (db: Db): Promise<Set<string>> =>
  new Set((await getSetting<string[]>(db, SETTING_DISABLED_SOURCES)) ?? []);

export async function setSourceEnabled(db: Db, sourceId: string, enabled: boolean): Promise<void> {
  const disabled = await getDisabledSources(db);
  if (enabled) disabled.delete(sourceId);
  else disabled.add(sourceId);
  await setSetting(db, SETTING_DISABLED_SOURCES, [...disabled].sort());
}

export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value as T | undefined;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  const values = { key, value, updatedAt: new Date() };
  await db
    .insert(settings)
    .values(values)
    .onConflictDoUpdate({ target: settings.key, set: values });
}

export const isPaused = async (db: Db): Promise<boolean> =>
  (await getSetting<boolean>(db, SETTING_PAUSED)) === true;

/* ------------------------------------------------------------- source state */

export async function getSourceStates(db: Db): Promise<Map<string, SourceStateRow>> {
  const rows = await db.select().from(sourceState);
  return new Map(rows.map((row) => [row.sourceId, row]));
}

/**
 * Takes the run lock for a source. Returns false when another run holds it. The lock expires
 * on its own, so a crashed run cannot block a source for ever.
 */
export async function claimSource(
  db: Db,
  source: { id: string; type: string },
  now: Date,
  lockMs: number,
): Promise<boolean> {
  const lockedUntil = new Date(now.getTime() + lockMs);
  const claimed = await db
    .insert(sourceState)
    .values({ sourceId: source.id, sourceType: source.type, lockedUntil })
    .onConflictDoUpdate({
      target: sourceState.sourceId,
      set: { lockedUntil },
      setWhere: sql`${sourceState.lockedUntil} is null or ${sourceState.lockedUntil} < ${now.toISOString()}`,
    })
    .returning({ sourceId: sourceState.sourceId });
  return claimed.length > 0;
}
