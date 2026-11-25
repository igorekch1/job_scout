import type { RawJob } from '../../normalize/job.js';
import type { FetchContext, Source } from '../types.js';
import { parsePost } from './post.js';
import type { ChannelReader } from './reader.js';

export const normalizeChannel = (name: string): string =>
  name
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/\/$/, '');

export function createTelegramChannelSource(
  channel: string,
  reader: ChannelReader,
  intervalMinutes: number,
  postsPerRun: number,
): Source {
  const name = normalizeChannel(channel);
  return {
    id: `telegram:${name}`,
    type: 'telegram',
    intervalMinutes,
    async fetch({ since }: FetchContext): Promise<RawJob[]> {
      const posts = await reader.read(name, postsPerRun);
      // posts already seen are filtered by the pipeline; skip clearly old ones early
      const cutoff = since ? since.getTime() - 24 * 60 * 60 * 1000 : -Infinity;
      return posts
        .filter((post) => post.date.getTime() >= cutoff)
        .flatMap((post) => parsePost(post, name) ?? []);
    },
  };
}
