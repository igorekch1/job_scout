# Adding a source

A source is anything that returns postings: an API, a feed, a channel. It implements one small
interface and knows nothing about filtering, deduplication or Telegram.

```ts
// src/sources/types.ts
export interface Source {
  id: string; // unique instance id, e.g. "lever:acme"; shown in /status
  type: string; // e.g. "lever"; used for the primary-link priority
  intervalMinutes: number;
  fetch(context: FetchContext): Promise<RawJob[]>;
}
```

## Steps

1. **Add settings to the schema** in `src/config/schema.ts`, under `sourcesSchema`. Every source has
   `enabled` and an optional `interval_minutes`. Describe each field with `.describe()`; the
   configuration reference is generated from those descriptions.

2. **Write the collector** in `src/sources/<name>.ts`. Keep the mapping from the source's payload to
   `RawJob` in a pure, exported function so it can be tested against a fixture:

   ```ts
   export function mapAcmeJob(input: unknown, board: string): RawJob | null {
     const parsed = jobSchema.safeParse(input); // validate with Zod; return null when malformed
     if (!parsed.success) return null;
     return {
       externalId: String(parsed.data.id), // stable id of the posting at this source
       url: parsed.data.url,
       title: parsed.data.title,
       company: parsed.data.company,
       descriptionHtml: parsed.data.body, // or descriptionText
       locationText: parsed.data.location, // as written; the normalizer parses it
       postedAt: parseDate(parsed.data.published_at),
       raw: input,
     };
   }

   export function createAcmeSource(board: string, intervalMinutes: number): Source {
     return {
       id: `acme:${board}`,
       type: 'acme',
       intervalMinutes,
       async fetch({ http }) {
         const result = await http.getJson(`https://api.acme.example/boards/${board}/jobs`);
         if (result.notModified) return []; // 304: nothing changed since the last run
         return parseResponse(result.data).flatMap((job) => mapAcmeJob(job, board) ?? []);
       },
     };
   }
   ```

3. **Register it** in `src/sources/registry.ts`: create one `Source` per configured board, feed or
   query.

4. **Add a fixture and tests.** Put a recorded response in `test/fixtures/`, replacing every real
   company, person and URL with made-up data, and test the mapper in `test/unit/sources.test.ts`.

5. **Regenerate the reference:** `pnpm docs:config`.

## Rules for collectors

- Use only `context.http`. It sets the User-Agent, sends conditional requests, backs off on `429` and
  `5xx` and spaces requests per host. Do not call `fetch` directly.
- Return what the source states and leave interpretation to the normalizer. Pass the location line
  as text; set `workMode`, `salary` or `employmentType` only when the source has a structured field
  for it.
- Returning postings that were seen before is fine. The pipeline deduplicates.
- Throw on failure. The pipeline records the error on the source, shows it in `/status` and retries
  later with a longer interval. Other sources are not affected.
- Use public, documented endpoints or feeds only. No scraping behind a login and no CAPTCHA solving.
