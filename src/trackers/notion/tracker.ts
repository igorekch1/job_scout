import type { Config, NotionField } from '../../config/schema.js';
import type { Tracker, TrackerEntry, TrackerHealth, TrackerResult } from '../types.js';
import { NotionClient, type NotionDataSource, type NotionPropertySchema } from './client.js';
import { encodeProperty, equalsFilter, type FieldValue } from './encode.js';

type NotionConfig = NonNullable<Config['tracker']['notion']>;

const SCHEMA_TTL_MS = 10 * 60 * 1000;
const SUPPORTED = new Set([
  'title',
  'rich_text',
  'url',
  'email',
  'phone_number',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'status',
]);

/** Exact key first, then keys ending in "*" as prefixes, longest prefix first. */
export function lookupValue(
  mapping: Readonly<Record<string, string>> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!mapping) return undefined;
  for (const key of keys) {
    if (mapping[key] !== undefined) return mapping[key];
  }
  const prefixes = Object.keys(mapping)
    .filter((key) => key.endsWith('*'))
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const match = prefixes.find((prefix) => key.startsWith(prefix.slice(0, -1)));
    if (match) return mapping[match];
  }
  return undefined;
}

function rawField(field: NotionField, entry: TrackerEntry): { value: FieldValue; keys: string[] } {
  switch (field) {
    case 'company':
      return { value: entry.company, keys: [] };
    case 'title':
      return { value: entry.title, keys: [] };
    case 'url':
      return { value: entry.url, keys: [] };
    case 'links':
      return { value: entry.links, keys: [] };
    case 'salary':
      return { value: entry.salary, keys: [] };
    case 'location':
      return { value: entry.location, keys: [] };
    case 'work_format':
      return { value: entry.workMode, keys: entry.workMode ? [entry.workMode] : [] };
    case 'employment':
      return {
        value: entry.employmentType,
        keys: entry.employmentType ? [entry.employmentType] : [],
      };
    case 'source':
      return { value: entry.source, keys: [entry.sourceId, entry.source] };
    case 'priority':
      return { value: entry.priority, keys: entry.priority ? [entry.priority] : [] };
    case 'industry':
      return { value: entry.industry ?? null, keys: entry.industry ? [entry.industry] : [] };
    case 'status':
      return { value: null, keys: [] };
    case 'posted_at':
      return { value: entry.postedAt, keys: [] };
    case 'added_at':
      return { value: entry.addedAt, keys: [] };
  }
}

/**
 * Writes tracked jobs as pages of a Notion data source. Property names and value mapping come
 * from config; property types are read from Notion, so any schema works.
 */
export class NotionTracker implements Tracker {
  readonly id = 'notion';
  private schema: { at: number; data: NotionDataSource } | undefined;

  constructor(
    private readonly settings: NotionConfig,
    private readonly client: NotionClient,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static create(config: Config, token: string, fetchImpl?: typeof fetch): NotionTracker {
    const settings = config.tracker.notion;
    if (!settings) throw new Error('tracker.notion is not configured');
    const client = new NotionClient({
      token,
      version: settings.api_version,
      fetch: fetchImpl,
      ...(fetchImpl ? { minIntervalMs: 0 } : {}),
    });
    return new NotionTracker(settings, client, config.user.timezone);
  }

  private async properties(fresh = false): Promise<Record<string, NotionPropertySchema>> {
    const at = this.now().getTime();
    if (fresh || !this.schema || at - this.schema.at > SCHEMA_TTL_MS) {
      this.schema = {
        at,
        data: await this.client.retrieveDataSource(this.settings.data_source_id),
      };
    }
    return this.schema.data.properties;
  }

  /** A defaults key: a mapped job field, else a property name (case-insensitive). */
  private propertyFor(key: string, properties: Record<string, NotionPropertySchema>): string {
    const mapped = this.settings.properties[key as NotionField];
    if (mapped) return mapped;
    if (properties[key]) return key;
    return Object.keys(properties).find((name) => name.toLowerCase() === key.toLowerCase()) ?? key;
  }

  /** Checks the mapping against the live schema. */
  async health(): Promise<TrackerHealth> {
    try {
      const properties = await this.properties(true);
      const problems: string[] = [];
      const check = (name: string, label: string, types?: string[]) => {
        const schema = properties[name];
        if (!schema) problems.push(`${label}: no property "${name}"`);
        else if (types ? !types.includes(schema.type) : !SUPPORTED.has(schema.type)) {
          problems.push(`${label}: "${name}" has unsupported type ${schema.type}`);
        }
      };
      for (const [field, name] of Object.entries(this.settings.properties)) check(name, field);
      for (const key of Object.keys(this.settings.defaults))
        check(this.propertyFor(key, properties), `defaults.${key}`);
      if (this.settings.auto_number)
        check(this.settings.auto_number.property, 'auto_number', ['number']);
      if (!Object.values(properties).some((schema) => schema.type === 'title')) {
        problems.push('the data source has no title property');
      }
      return problems.length > 0
        ? { ok: false, detail: problems.join('; ') }
        : { ok: true, detail: 'mapping matches the data source' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async findExisting(
    properties: Record<string, NotionPropertySchema>,
    entry: TrackerEntry,
  ): Promise<{ id: string; url?: string } | undefined> {
    const name = this.settings.properties.url;
    const schema = name ? properties[name] : undefined;
    if (!schema) return undefined;
    const filters = [...new Set([entry.url, ...entry.links])]
      .slice(0, 5)
      .map((url) => equalsFilter(schema, url))
      .filter((filter): filter is Record<string, unknown> => filter !== null);
    if (filters.length === 0) return undefined;
    const result = await this.client.queryDataSource(this.settings.data_source_id, {
      filter: filters.length === 1 ? filters[0] : { or: filters },
      page_size: 1,
    });
    return result.results[0];
  }

  private async nextNumber(property: string): Promise<number> {
    const result = await this.client.queryDataSource(this.settings.data_source_id, {
      sorts: [{ property, direction: 'descending' }],
      page_size: 1,
    });
    const current = result.results[0]?.properties?.[property]?.number;
    return typeof current === 'number' ? Math.floor(current) + 1 : 1;
  }

  async add(entry: TrackerEntry): Promise<TrackerResult> {
    const properties = await this.properties();
    const existing = await this.findExisting(properties, entry);
    if (existing) return { ref: existing.id, url: existing.url, duplicate: true };

    const body: Record<string, unknown> = {};
    const skipped: string[] = [];
    const encodeOptions = {
      timeZone: this.timeZone,
      createSelectOptions: this.settings.create_select_options,
    };
    const write = (property: string, value: FieldValue, label: string): void => {
      const schema = properties[property];
      if (!schema) {
        skipped.push(`${label}: no property "${property}"`);
        return;
      }
      const encoded = encodeProperty(schema, value, encodeOptions);
      if (encoded.ok) body[property] = encoded.value;
      else if (encoded.reason !== 'no value') skipped.push(`${label}: ${encoded.reason}`);
    };

    for (const [key, value] of Object.entries(this.settings.defaults)) {
      write(this.propertyFor(key, properties), value, key);
    }
    for (const [field, property] of Object.entries(this.settings.properties) as [
      NotionField,
      string,
    ][]) {
      const { value, keys } = rawField(field, entry);
      if (value === null || value === undefined) continue;
      const mapped = lookupValue(this.settings.values[field], keys);
      write(property, mapped ?? value, field);
    }

    const titleProperty = Object.values(properties).find((schema) => schema.type === 'title');
    if (titleProperty && !body[titleProperty.name]) {
      // a page needs a title: fall back to "Company: Title"
      body[titleProperty.name] = {
        title: [{ text: { content: [entry.company, entry.title].filter(Boolean).join(': ') } }],
      };
    }

    if (this.settings.auto_number) {
      const property = this.settings.auto_number.property;
      if (properties[property]?.type === 'number') {
        body[property] = { number: await this.nextNumber(property) };
      } else {
        skipped.push(`auto_number: "${property}" is not a number property`);
      }
    }

    const page = await this.client.createPage({
      parent: { type: 'data_source_id', data_source_id: this.settings.data_source_id },
      properties: body,
    });
    return { ref: page.id, url: page.url, duplicate: false, skipped };
  }
}
