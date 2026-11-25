import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load.js';
import {
  NotionClient,
  NotionError,
  type NotionPropertySchema,
} from '../../src/trackers/notion/client.js';
import { encodeProperty, isoDate } from '../../src/trackers/notion/encode.js';
import { lookupValue, NotionTracker } from '../../src/trackers/notion/tracker.js';
import type { TrackerEntry } from '../../src/trackers/types.js';

const DS = '00000000-0000-4000-8000-000000000001';

const options = (names: string[]) => names.map((name) => ({ name }));

/** A tracker schema with a text link, a select source, a status and a running number. */
const SCHEMA: Record<string, NotionPropertySchema> = {
  Company: { id: 'title', name: 'Company', type: 'title' },
  Position: { id: 'p1', name: 'Position', type: 'rich_text' },
  Link: { id: 'p2', name: 'Link', type: 'rich_text' },
  Pay: { id: 'p3', name: 'Pay', type: 'rich_text' },
  Format: {
    id: 'p4',
    name: 'Format',
    type: 'select',
    select: { options: options(['Remote', 'Hybrid', 'Office']) },
  },
  Source: {
    id: 'p5',
    name: 'Source',
    type: 'select',
    select: { options: options(['Board A', 'Company website']) },
  },
  Priority: {
    id: 'p6',
    name: 'Priority',
    type: 'select',
    select: { options: options(['P1', 'P2']) },
  },
  Status: {
    id: 'p7',
    name: 'Status',
    type: 'status',
    status: { options: options(['To Apply', 'Applied']) },
  },
  Posted: { id: 'p8', name: 'Posted', type: 'date' },
  Added: { id: 'p9', name: 'Added', type: 'date' },
  '#': { id: 'p10', name: '#', type: 'number' },
  Owner: { id: 'p11', name: 'Owner', type: 'people' },
};

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** In-memory stand-in for the three Notion endpoints the tracker uses. */
function fakeNotion(
  init: { pages?: { id: string; link: string; number: number }[]; fail?: Response[] } = {},
) {
  const calls: Call[] = [];
  const pages = [...(init.pages ?? [])];
  const failures = [...(init.fail ?? [])];
  const fetchImpl = ((
    url: string,
    request: { method: string; body?: string; headers: Record<string, string> },
  ) => {
    const path = url.replace('https://api.notion.com/v1', '');
    const body = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : undefined;
    calls.push({ method: request.method, path, body, headers: request.headers });
    const failure = failures.shift();
    if (failure) return Promise.resolve(failure);
    const json = (data: unknown) => Promise.resolve(Response.json(data));

    if (request.method === 'GET' && path === `/data_sources/${DS}`) {
      return json({ object: 'data_source', id: DS, properties: SCHEMA });
    }
    if (path === `/data_sources/${DS}/query`) {
      const filter = body?.filter as Record<string, unknown> | undefined;
      if (filter) {
        const wanted = (filter.or as Record<string, { equals: string }>[] | undefined) ?? [filter];
        const urls = wanted.map((entry) => (entry.rich_text as { equals: string }).equals);
        const hit = pages.find((page) => urls.includes(page.link));
        return json({
          results: hit ? [{ id: hit.id, url: `https://notion.example/${hit.id}` }] : [],
          has_more: false,
        });
      }
      const top = [...pages].sort((a, b) => b.number - a.number)[0];
      return json({
        results: top
          ? [{ id: top.id, properties: { '#': { type: 'number', number: top.number } } }]
          : [],
        has_more: false,
      });
    }
    if (request.method === 'POST' && path === '/pages') {
      const id = `page-${pages.length + 1}`;
      const props = body?.properties as Record<
        string,
        { rich_text?: { text: { content: string } }[]; number?: number }
      >;
      pages.push({
        id,
        link: props.Link?.rich_text?.[0]?.text.content ?? '',
        number: props['#']?.number ?? 0,
      });
      return json({ object: 'page', id, url: `https://notion.example/${id}` });
    }
    return Promise.resolve(
      Response.json(
        { object: 'error', status: 404, code: 'object_not_found', message: 'nope' },
        { status: 404 },
      ),
    );
  }) as unknown as typeof fetch;
  return { calls, pages, fetchImpl };
}

const config = (notion: Record<string, unknown> = {}) =>
  parseConfig({
    user: { timezone: 'Europe/Amsterdam', country: 'NL' },
    tracker: {
      type: 'notion',
      notion: {
        data_source_id: DS,
        properties: {
          company: 'Company',
          title: 'Position',
          url: 'Link',
          salary: 'Pay',
          work_format: 'Format',
          source: 'Source',
          priority: 'Priority',
          posted_at: 'Posted',
          added_at: 'Added',
        },
        values: {
          work_format: { remote: 'Remote', onsite: 'Office' },
          source: { 'rss:board-a-*': 'Board A', greenhouse: 'Company website' },
        },
        defaults: { status: 'To Apply' },
        auto_number: { property: '#' },
        ...notion,
      },
    },
  });

const makeTracker = (fetchImpl: typeof fetch, cfg = config()) => {
  const settings = cfg.tracker.notion!;
  const client = new NotionClient({
    token: 'secret_test',
    version: settings.api_version,
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    minIntervalMs: 0,
  });
  return new NotionTracker(settings, client, cfg.user.timezone);
};

const entry = (overrides: Partial<TrackerEntry> = {}): TrackerEntry => ({
  jobId: 7,
  company: 'Acme Robotics',
  title: 'Senior Frontend Engineer',
  url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001',
  links: [
    'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001',
    'https://jobs.example.com/jobs/1001',
  ],
  source: 'greenhouse',
  sourceId: 'greenhouse:acmerobotics',
  salary: '€90k–120k / year',
  location: 'Remote - Europe',
  workMode: 'remote',
  employmentType: 'full_time',
  priority: null,
  postedAt: new Date('2026-03-01T23:30:00Z'),
  addedAt: new Date('2026-03-05T12:00:00Z'),
  ...overrides,
});

describe('NotionTracker.add', () => {
  it('creates a page with values encoded for each property type', async () => {
    const notion = fakeNotion({ pages: [{ id: 'old', link: 'https://x.example/1', number: 41 }] });
    const result = await makeTracker(notion.fetchImpl).add(entry());

    expect(result).toEqual({
      ref: 'page-2',
      url: 'https://notion.example/page-2',
      duplicate: false,
      skipped: [],
    });
    const create = notion.calls.find((call) => call.path === '/pages')!;
    expect(create.headers).toMatchObject({
      authorization: 'Bearer secret_test',
      'notion-version': '2026-03-11',
    });
    expect(create.body).toEqual({
      parent: { type: 'data_source_id', data_source_id: DS },
      properties: {
        Status: { status: { name: 'To Apply' } },
        Company: { title: [{ text: { content: 'Acme Robotics' } }] },
        Position: { rich_text: [{ text: { content: 'Senior Frontend Engineer' } }] },
        Link: {
          rich_text: [
            {
              text: {
                content: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001',
                link: { url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001' },
              },
            },
          ],
        },
        Pay: { rich_text: [{ text: { content: '€90k–120k / year' } }] },
        Format: { select: { name: 'Remote' } },
        Source: { select: { name: 'Company website' } },
        // dates are calendar days in the user's time zone
        Posted: { date: { start: '2026-03-02' } },
        Added: { date: { start: '2026-03-05' } },
        '#': { number: 42 },
      },
    });
  });

  it('maps sources by id prefix', async () => {
    const notion = fakeNotion();
    await makeTracker(notion.fetchImpl).add(
      entry({
        source: 'rss',
        sourceId: 'rss:board-a-frontend',
        url: 'https://jobs.example.com/9',
        links: [],
      }),
    );
    const create = notion.calls.find((call) => call.path === '/pages')!;
    expect((create.body!.properties as Record<string, unknown>).Source).toEqual({
      select: { name: 'Board A' },
    });
    expect((create.body!.properties as Record<string, unknown>)['#']).toEqual({ number: 1 });
  });

  it('skips values that are not existing options and reports them', async () => {
    const notion = fakeNotion();
    const result = await makeTracker(notion.fetchImpl).add(
      entry({ source: 'rss', sourceId: 'rss:other', workMode: 'hybrid', priority: 'P9' }),
    );
    expect(result.skipped).toEqual([
      'work_format: "hybrid" is not an option of "Format"',
      'source: "rss" is not an option of "Source"',
      'priority: "P9" is not an option of "Priority"',
    ]);
    const properties = notion.calls.find((call) => call.path === '/pages')!.body!
      .properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty('Source');
    expect(properties).not.toHaveProperty('Format');
  });

  it('lets Notion create select options when allowed', async () => {
    const notion = fakeNotion();
    const result = await makeTracker(notion.fetchImpl, config({ create_select_options: true })).add(
      entry({ source: 'rss', sourceId: 'rss:other' }),
    );
    expect(result.skipped).toEqual([]);
    const properties = notion.calls.find((call) => call.path === '/pages')!.body!
      .properties as Record<string, unknown>;
    expect(properties.Source).toEqual({ select: { name: 'rss' } });
  });

  it('does not create a second page for a job already in the database', async () => {
    const notion = fakeNotion({
      pages: [{ id: 'existing', link: 'https://jobs.example.com/jobs/1001', number: 3 }],
    });
    const result = await makeTracker(notion.fetchImpl).add(entry());
    expect(result).toEqual({
      ref: 'existing',
      url: 'https://notion.example/existing',
      duplicate: true,
    });
    expect(notion.calls.some((call) => call.path === '/pages')).toBe(false);
    const query = notion.calls.find((call) => call.path.endsWith('/query'))!;
    expect(query.body).toEqual({
      filter: {
        or: [
          {
            property: 'Link',
            rich_text: { equals: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001' },
          },
          { property: 'Link', rich_text: { equals: 'https://jobs.example.com/jobs/1001' } },
        ],
      },
      page_size: 1,
    });
  });

  it('falls back to "Company: Title" when the title property is not mapped', async () => {
    const notion = fakeNotion();
    const cfg = config({ properties: { url: 'Link' } });
    await makeTracker(notion.fetchImpl, cfg).add(entry());
    const properties = notion.calls.find((call) => call.path === '/pages')!.body!
      .properties as Record<string, unknown>;
    expect(properties.Company).toEqual({
      title: [{ text: { content: 'Acme Robotics: Senior Frontend Engineer' } }],
    });
  });

  it('retries a rate-limited request and explains a permanent failure', async () => {
    const limited = new Response(
      JSON.stringify({ object: 'error', status: 429, code: 'rate_limited', message: 'slow down' }),
      {
        status: 429,
        headers: { 'retry-after': '1' },
      },
    );
    const notion = fakeNotion({ fail: [limited] });
    expect((await makeTracker(notion.fetchImpl).add(entry())).duplicate).toBe(false);

    const missing = new Response(
      JSON.stringify({
        object: 'error',
        status: 404,
        code: 'object_not_found',
        message: 'Could not find data source',
      }),
      { status: 404 },
    );
    const broken = fakeNotion({ fail: [missing] });
    const error = await makeTracker(broken.fetchImpl)
      .add(entry())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as Error).message).toContain('share the database with your integration');
  });

  it('does not retry a failed page create', async () => {
    const unavailable = () =>
      new Response(JSON.stringify({ object: 'error', status: 503, code: 'service_unavailable' }), {
        status: 503,
      });
    const failing = fakeNotion({ fail: [] });
    let creates = 0;
    const fetchImpl = ((
      url: string,
      init: { method: string; body?: string; headers: Record<string, string> },
    ) => {
      if (url.endsWith('/pages')) {
        creates += 1;
        return Promise.resolve(unavailable());
      }
      return failing.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    await expect(makeTracker(fetchImpl).add(entry())).rejects.toThrow(
      'Notion 503 service_unavailable',
    );
    expect(creates).toBe(1);
  });
});

describe('NotionTracker.health', () => {
  it('passes when every mapped property exists with a supported type', async () => {
    expect(await makeTracker(fakeNotion().fetchImpl).health()).toEqual({
      ok: true,
      detail: 'mapping matches the data source',
    });
  });

  it('lists missing and unsupported properties', async () => {
    const cfg = config({
      properties: { company: 'Company', title: 'Role', salary: 'Owner' },
      auto_number: { property: 'Pay' },
    });
    const health = await makeTracker(fakeNotion().fetchImpl, cfg).health();
    expect(health.ok).toBe(false);
    expect(health.detail).toBe(
      'title: no property "Role"; salary: "Owner" has unsupported type people; auto_number: "Pay" has unsupported type rich_text',
    );
  });
});

describe('notion helpers', () => {
  it('looks up mapped values exactly, then by the longest prefix', () => {
    const mapping = { greenhouse: 'Company website', 'rss:*': 'Feed', 'rss:board-a-*': 'Board A' };
    expect(lookupValue(mapping, ['greenhouse:acme', 'greenhouse'])).toBe('Company website');
    expect(lookupValue(mapping, ['rss:board-a-x', 'rss'])).toBe('Board A');
    expect(lookupValue(mapping, ['rss:other', 'rss'])).toBe('Feed');
    expect(lookupValue(mapping, ['ashby:x', 'ashby'])).toBeUndefined();
    expect(lookupValue(undefined, ['x'])).toBeUndefined();
  });

  it('encodes values by property type', () => {
    const opts = { timeZone: 'UTC', createSelectOptions: false };
    expect(encodeProperty({ id: '1', name: 'L', type: 'url' }, 'https://x.example', opts)).toEqual({
      ok: true,
      value: { url: 'https://x.example' },
    });
    expect(encodeProperty({ id: '1', name: 'N', type: 'number' }, '12', opts)).toEqual({
      ok: true,
      value: { number: 12 },
    });
    expect(encodeProperty({ id: '1', name: 'N', type: 'number' }, 'twelve', opts).ok).toBe(false);
    expect(encodeProperty({ id: '1', name: 'C', type: 'checkbox' }, true, opts)).toEqual({
      ok: true,
      value: { checkbox: true },
    });
    expect(
      encodeProperty(
        {
          id: '1',
          name: 'T',
          type: 'multi_select',
          multi_select: { options: options(['a', 'b']) },
        },
        ['a', 'b'],
        opts,
      ),
    ).toEqual({ ok: true, value: { multi_select: [{ name: 'a' }, { name: 'b' }] } });
    expect(encodeProperty({ id: '1', name: 'R', type: 'relation' }, 'x', opts)).toEqual({
      ok: false,
      reason: 'property type "relation" is not supported',
    });
    const long = encodeProperty({ id: '1', name: 'R', type: 'rich_text' }, 'x'.repeat(2500), opts);
    expect(JSON.stringify(long).length).toBeLessThan(2100);
    expect(
      encodeProperty(
        { id: '1', name: 'S', type: 'select', select: { options: options(['A B']) } },
        'A, B',
        opts,
      ),
    ).toEqual({
      ok: true,
      value: { select: { name: 'A B' } },
    });
  });

  it('formats calendar dates in a time zone', () => {
    const late = new Date('2026-03-01T23:30:00Z');
    expect(isoDate(late, 'UTC')).toBe('2026-03-01');
    expect(isoDate(late, 'Europe/Amsterdam')).toBe('2026-03-02');
  });

  it('rejects unknown fields in the property mapping', () => {
    expect(() => config({ properties: { compnay: 'Company' } })).toThrow(
      /tracker\.notion\.properties/,
    );
  });
});
