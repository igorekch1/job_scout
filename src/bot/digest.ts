import type { Api } from 'grammy';
import type { Config } from '../config/schema.js';
import type { Db } from '../db/client.js';
import { getSetting, setSetting, SETTING_DIGEST_SENT_DAY } from '../db/stores.js';
import { dayIn } from '../llm/budget.js';
import type { Logger } from '../logger.js';
import { buildDigest, localTime } from './reports.js';

export interface DigestDeps {
  db: Db;
  config: Config;
  api: Api;
  logger: Logger;
}

/**
 * Sends the daily digest once per calendar day, at or after `telegram.digest.time` in the user's
 * time zone. The sent day is stored, so a restart neither skips nor repeats a digest.
 */
export async function maybeSendDigest(deps: DigestDeps, now: Date): Promise<boolean> {
  const { db, config, api, logger } = deps;
  const settings = config.telegram.digest;
  if (!settings.enabled || config.telegram.allowed_chat_ids.length === 0) return false;

  const zone = config.user.timezone;
  if (localTime(now, zone) < settings.time) return false;
  const today = dayIn(now, zone);
  if ((await getSetting<string>(db, SETTING_DIGEST_SENT_DAY)) === today) return false;

  // mark first: a failure below must not turn into a digest every minute
  await setSetting(db, SETTING_DIGEST_SENT_DAY, today);
  const text = await buildDigest(db, config, now);
  for (const chatId of config.telegram.allowed_chat_ids) {
    try {
      await api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      logger.warn({ chatId, err: error }, 'could not send the daily digest');
    }
  }
  return true;
}
