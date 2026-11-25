import { readFileSync } from 'node:fs';
import { parseConfig } from '../src/config/load.js';
import type { Config } from '../src/config/schema.js';
import type { Job, RawJob } from '../src/normalize/job.js';
import { normalizeJob } from '../src/normalize/normalize.js';

export const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export const jsonFixture = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** A valid config for a fictional user in the Netherlands; pass overrides per test. */
export function testConfig(overrides: DeepPartial<Record<string, unknown>> = {}): Config {
  return parseConfig({
    user: { timezone: 'Europe/Amsterdam', country: 'NL', country_aliases: ['netherlands'] },
    telegram: { allowed_chat_ids: [1001] },
    ...overrides,
  });
}

/** Builds a normalized job from a few raw fields. */
export function makeJob(
  raw: Partial<RawJob> = {},
  source = { id: 'test:board', type: 'test' },
): Job {
  return normalizeJob(
    {
      externalId: raw.url ?? 'job-1',
      url: 'https://jobs.example.com/jobs/1',
      title: 'Senior Frontend Engineer',
      company: 'Acme Robotics',
      descriptionText: 'Build React and TypeScript interfaces.',
      locationText: 'Remote - Europe',
      raw: {},
      ...raw,
    },
    source,
  );
}
