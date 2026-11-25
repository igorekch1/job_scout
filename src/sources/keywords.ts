import { findKeyword } from '../util/text.js';

/** True when no keywords are set, or any of them appears in one of the texts. */
export function matchesAny(
  keywords: readonly string[],
  ...texts: (string | null | undefined)[]
): boolean {
  if (keywords.length === 0) return true;
  const haystack = texts.filter(Boolean).join('\n');
  return findKeyword(haystack, keywords) !== undefined;
}
