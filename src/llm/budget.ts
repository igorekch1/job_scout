import { eq, sum } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { llmUsage } from '../db/schema.js';
import { isoDate } from '../trackers/notion/encode.js';
import type { TokenUsage } from './pricing.js';

export const dayIn = (date: Date, timeZone: string): string => isoDate(date, timeZone);

export async function spentOn(db: Db, day: string): Promise<number> {
  const [row] = await db
    .select({ total: sum(llmUsage.costUsd).mapWith(Number) })
    .from(llmUsage)
    .where(eq(llmUsage.day, day));
  return row?.total ?? 0;
}

export async function recordUsage(
  db: Db,
  input: {
    day: string;
    purpose: string;
    model: string;
    usage: TokenUsage;
    costUsd: number;
    at: Date;
  },
): Promise<void> {
  await db.insert(llmUsage).values({
    day: input.day,
    purpose: input.purpose,
    model: input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    costUsd: input.costUsd,
    createdAt: input.at,
  });
}
