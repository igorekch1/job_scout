import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { deliveries, jobs, trackerEntries } from '../../src/db/schema.js';
import { greenhouseBoardUrl, greenhouseJobUrl } from '../../src/sources/greenhouse.js';
import { fixture, testConfig } from '../helpers.js';
import { createHarness, type Harness } from './harness.js';

const DS = '00000000-0000-4000-8000-000000000002';
const GREENHOUSE = greenhouseBoardUrl('acmerobotics');

const SCHEMA = {
  Role: { id: 'title', name: 'Role', type: 'title' },
  Link: { id: 'a', name: 'Link', type: 'url' },
  Stage: { id: 'b', name: 'Stage', type: 'status', status: { options: [{ name: 'Inbox' }] } },
};

function notionApi() {
  const created: Record<string, unknown>[] = [];
  const fetchImpl = ((url: string, init: { method: string; body?: string }) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith(`/data_sources/${DS}`))
      return Promise.resolve(Response.json({ id: DS, properties: SCHEMA }));
    if (url.endsWith('/query'))
      return Promise.resolve(Response.json({ results: [], has_more: false }));
    if (url.endsWith('/pages')) {
      created.push(body);
      return Promise.resolve(
        Response.json({ object: 'page', id: 'page-1', url: 'https://notion.example/page-1' }),
      );
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as unknown as typeof fetch;
  return { created, fetchImpl };
}

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('Add to tracker with Notion', () => {
  it('checks liveness, creates the page, records it locally and links it on the card', async () => {
    const notion = notionApi();
    const config = testConfig({
      sources: { greenhouse: { enabled: true, boards: ['acmerobotics'] } },
      tracker: {
        type: 'notion',
        notion: {
          data_source_id: DS,
          properties: { title: 'Role', url: 'Link' },
          defaults: { Stage: 'Inbox' },
        },
      },
    });
    h = await createHarness(config, '2026-03-05T12:00:00Z', { notionFetch: notion.fetchImpl });
    h.web.set(GREENHOUSE, fixture('greenhouse-board.json'));
    h.web.set(greenhouseJobUrl('acmerobotics', '4000001'), '{"id":4000001}');
    await h.collect();
    await h.outbox.tick();

    const [job] = await h.db.select().from(jobs).where(eq(jobs.title, 'Senior Frontend Engineer'));
    const [delivery] = await h.db.select().from(deliveries).where(eq(deliveries.jobId, job!.id));
    await h.press(delivery!.messageId!, `t:${job!.id}`);

    expect(notion.created).toEqual([
      {
        parent: { type: 'data_source_id', data_source_id: DS },
        properties: {
          Stage: { status: { name: 'Inbox' } },
          Role: { title: [{ text: { content: 'Senior Frontend Engineer' } }] },
          Link: { url: 'https://job-boards.greenhouse.io/acmerobotics/jobs/4000001' },
        },
      },
    ]);
    expect(await h.db.select().from(trackerEntries)).toMatchObject([
      {
        jobId: job!.id,
        tracker: 'notion',
        externalRef: 'page-1',
        externalUrl: 'https://notion.example/page-1',
      },
    ]);
    expect(h.lastText()).toContain(
      '✅ Added to <a href="https://notion.example/page-1">tracker</a>',
    );

    await h.say('/status');
    expect(h.lastText()).toContain('<b>Tracker:</b> notion ✅');
    expect(h.lastText()).toContain('1 tracked');
  });
});
