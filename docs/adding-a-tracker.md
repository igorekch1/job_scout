# Adding a tracker adapter

A tracker is where **Add to tracker** writes: the built-in Postgres table, a Notion database, a
spreadsheet. It implements one method.

```ts
// src/trackers/types.ts
export interface Tracker {
  readonly id: string;
  add(entry: TrackerEntry): Promise<TrackerResult>;
}
```

`TrackerEntry` carries the job as the user saw it on the card: company, title, primary URL, every
other link, source, formatted pay, location, work mode, employment type, priority, publish date and
the time it was added. `TrackerResult` returns a reference to the created row, optionally a URL to
it, and whether the job was already there.

## Steps

1. **Add settings to the schema** in `src/config/schema.ts`: extend the `tracker.type` enum and add
   a settings block for the adapter. Keep secrets in environment variables, validated in
   `src/config/env.ts`.

2. **Write the adapter** in `src/trackers/<name>.ts`:

   ```ts
   export class SheetTracker implements Tracker {
     readonly id = 'sheet';

     async add(entry: TrackerEntry): Promise<TrackerResult> {
       const existing = await this.findRow(entry.jobId);
       if (existing) return { ref: existing.id, url: existing.url, duplicate: true };
       const row = await this.appendRow(entry);
       return { ref: row.id, url: row.url, duplicate: false };
     }
   }
   ```

3. **Return it from `createTracker`** in `src/trackers/index.ts`.

4. **Test it** with the external API mocked. Do not call real services from tests.

## Contract

- `add` must be idempotent per `entry.jobId`: a second call for the same job must not create a
  second row. Report it with `duplicate: true`.
- Throw on failure with a message that is safe to show to the user. The bot displays it on the card
  and leaves the buttons in place, so the user can try again.
- The liveness check runs before `add` and is not the adapter's concern.
- Map fields through configuration and avoid hard-coded column or property names, so the adapter
  works with any layout.
