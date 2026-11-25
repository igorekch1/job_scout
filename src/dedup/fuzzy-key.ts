const LEGAL_SUFFIXES =
  /\b(?:inc|incorporated|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|ag|bv|sa|sas|srl|oy|ab|as|pte|pty)\b\.?/g;

const TITLE_SYNONYMS: readonly (readonly [RegExp, string])[] = [
  [/\bsr\b\.?/g, 'senior'],
  [/\bjr\b\.?/g, 'junior'],
  [/\bfront[\s-]?end\b/g, 'frontend'],
  [/\bback[\s-]?end\b/g, 'backend'],
  [/\bfull[\s-]?stack\b/g, 'fullstack'],
  [/\bdeveloper\b/g, 'engineer'],
  [/\bsoftware engineer\b/g, 'engineer'],
  [/&/g, ' and '],
];

const strip = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function normalizeCompany(company: string): string {
  return strip(company)
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normalizeTitle(title: string): string {
  let text = strip(title)
    // "(Remote, EMEA)", "[m/f/d]" and similar annotations
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    // trailing " - Remote", " | Europe", " — Contract"
    .replace(/\s[-–—|]\s.*$/, ' ');
  for (const [pattern, replacement] of TITLE_SYNONYMS) {
    text = text.replace(pattern, replacement);
  }
  return text
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Key shared by the same role posted on several boards. Without a company there is nothing
 * safe to match on, so the canonical URL becomes the key and the job stays on its own.
 */
export function fuzzyKey(
  company: string | null | undefined,
  title: string,
  canonical: string,
): string {
  const normalizedCompany = company ? normalizeCompany(company) : '';
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedCompany || !normalizedTitle) return `url:${canonical}`;
  return `${normalizedCompany}|${normalizedTitle}`;
}
