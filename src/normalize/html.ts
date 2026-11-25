import { convert } from 'html-to-text';

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the handful of entities that appear in escaped HTML payloads. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

const looksEscaped = (html: string): boolean =>
  /&lt;\/?[a-z][^&]*&gt;/i.test(html) && !/<[a-z]/i.test(html);

/** Converts a posting body to plain text. Handles entity-escaped HTML (as Greenhouse returns). */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const source = looksEscaped(html) ? decodeEntities(html) : html;
  const text = convert(source, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'ul', options: { itemPrefix: '- ' } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
    ],
  });
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
