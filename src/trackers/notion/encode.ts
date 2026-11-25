import type { NotionPropertySchema } from './client.js';

export type FieldValue = string | number | boolean | Date | string[] | null | undefined;

const RICH_TEXT_LIMIT = 2000;

const clip = (text: string): string =>
  text.length > RICH_TEXT_LIMIT ? `${text.slice(0, RICH_TEXT_LIMIT - 1)}…` : text;

/** "YYYY-MM-DD" of the instant in the given zone. */
export function isoDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const asText = (value: FieldValue, timeZone: string): string => {
  if (value instanceof Date) return isoDate(value, timeZone);
  if (Array.isArray(value)) return value.join('\n');
  return String(value);
};

const isUrl = (text: string): boolean => /^https?:\/\/\S+$/.test(text);

/** Option names may not contain commas. */
const optionName = (text: string): string => text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();

export type Encoded = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/**
 * Builds the property value for a page create, according to the property's type in Notion.
 * Returns a reason instead when the value cannot be written.
 */
export function encodeProperty(
  schema: NotionPropertySchema,
  value: FieldValue,
  options: { timeZone: string; createSelectOptions: boolean },
): Encoded {
  if (value === null || value === undefined || value === '')
    return { ok: false, reason: 'no value' };
  const text = asText(value, options.timeZone);

  const checkOption = (name: string, available: { name: string }[] | undefined): Encoded | null => {
    if (options.createSelectOptions && schema.type !== 'status') return null;
    if (available?.some((option) => option.name === name)) return null;
    return { ok: false, reason: `"${name}" is not an option of "${schema.name}"` };
  };

  switch (schema.type) {
    case 'title':
      return { ok: true, value: { title: [{ text: { content: clip(text) } }] } };
    case 'rich_text': {
      const content = clip(text);
      const link = isUrl(content) ? { link: { url: content } } : {};
      return { ok: true, value: { rich_text: [{ text: { content, ...link } }] } };
    }
    case 'url':
      return { ok: true, value: { url: clip(text) } };
    case 'email':
      return { ok: true, value: { email: text.slice(0, 200) } };
    case 'phone_number':
      return { ok: true, value: { phone_number: text.slice(0, 200) } };
    case 'number': {
      const number = typeof value === 'number' ? value : Number(text);
      return Number.isFinite(number)
        ? { ok: true, value: { number } }
        : { ok: false, reason: `"${text}" is not a number` };
    }
    case 'checkbox':
      return { ok: true, value: { checkbox: value === true || text === 'true' } };
    case 'date': {
      const date = value instanceof Date ? value : new Date(text);
      if (Number.isNaN(date.getTime()) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return { ok: false, reason: `"${text}" is not a date` };
      }
      const start = value instanceof Date ? isoDate(value, options.timeZone) : text;
      return { ok: true, value: { date: { start } } };
    }
    case 'select': {
      const name = optionName(text);
      return checkOption(name, schema.select?.options) ?? { ok: true, value: { select: { name } } };
    }
    case 'status': {
      const name = optionName(text);
      return checkOption(name, schema.status?.options) ?? { ok: true, value: { status: { name } } };
    }
    case 'multi_select': {
      const names = (Array.isArray(value) ? value : text.split(/\n/))
        .map(optionName)
        .filter(Boolean);
      for (const name of names) {
        const problem = checkOption(name, schema.multi_select?.options);
        if (problem) return problem;
      }
      return { ok: true, value: { multi_select: names.map((name) => ({ name })) } };
    }
    default:
      return { ok: false, reason: `property type "${schema.type}" is not supported` };
  }
}

/** Filter that matches a page whose property equals the value, for duplicate detection. */
export function equalsFilter(
  schema: NotionPropertySchema,
  value: string,
): Record<string, unknown> | null {
  switch (schema.type) {
    case 'url':
    case 'title':
    case 'rich_text':
    case 'email':
      return { property: schema.name, [schema.type]: { equals: value } };
    default:
      return null;
  }
}
