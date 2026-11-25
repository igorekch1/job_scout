import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION: string = manifest.version;

/** Descriptive User-Agent. Contact details are opt-in through `app.user_agent_contact`. */
export function userAgent(contact = ''): string {
  const base = `job-scout/${VERSION}`;
  return contact.trim() ? `${base} (+${contact.trim()})` : base;
}
