const WORD = '[\\p{L}\\p{N}]';

export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map<string, RegExp>();

/**
 * Whole-word, case-insensitive matcher that also works for terms such as "c++", ".net" or
 * "node.js", where `\b` gives the wrong answer.
 */
export function keywordRegex(keyword: string, flags = 'iu'): RegExp {
  const key = `${flags}:${keyword}`;
  let regex = cache.get(key);
  if (!regex) {
    const trimmed = keyword.trim();
    const body = escapeRegex(trimmed).replace(/\s+/g, '\\s+');
    // a boundary only makes sense next to a letter or digit: ".net" and "c++" have none there
    const edge = new RegExp(WORD, 'u');
    const before = edge.test(trimmed.charAt(0)) ? `(?<!${WORD})` : '';
    const after = edge.test(trimmed.charAt(trimmed.length - 1)) ? `(?!${WORD})` : '';
    regex = new RegExp(`${before}${body}${after}`, flags);
    cache.set(key, regex);
  }
  return regex;
}

export const hasKeyword = (text: string, keyword: string): boolean =>
  keywordRegex(keyword).test(text);

export const findKeyword = (text: string, keywords: readonly string[]): string | undefined =>
  keywords.find((keyword) => hasKeyword(text, keyword));

export function countKeyword(text: string, keyword: string): number {
  return text.match(keywordRegex(keyword, 'giu'))?.length ?? 0;
}

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
