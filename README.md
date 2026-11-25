# job-scout

A self-hosted Telegram bot that finds fresh job postings, filters them against rules you define and
sends each match to you as a card you can act on in one tap.

The goal is speed: a matching job should reach you within minutes of being published.

> **Status:** working today: RSS/Atom, Greenhouse and Ashby sources, the rule filter,
> deduplication, optional LLM scoring, Telegram cards with _Add to tracker_, _Reject_ and _Later_,
> the built-in Postgres tracker and the Notion tracker. See the [roadmap](#roadmap) for what comes
> next.

## What it does

1. **Collects** postings from the sources you enable, each on its own interval (10 to 15 minutes by
   default).
2. **Normalizes** every posting to one shape: company, title, description, location, remote flag,
   allowed countries or regions, pay, employment type and publish date.
3. **Deduplicates** by canonical URL and by company plus title, so a role found on several boards is
   one job with several links. The employer's own ATS link is preferred as the primary one.
4. **Filters** with your rules: title and seniority keywords, stack, location, pay floors, working
   hours and age. Every dropped posting records why.
5. **Scores** the kept postings with Claude, if you turn it on: a priority bucket, a fit score, a
   one-line reason, the detected stack and red flags, judged against your `profile.md`.
6. **Delivers** one card per kept job to your Telegram chat, with buttons:
   - **Add to tracker** re-checks that the posting is still open, then saves it.
   - **Reject** asks for a reason from your list and stores it.
   - **Later** hides the card and sends it again after the time you pick.

When more jobs are waiting than `telegram.batch_threshold`, you get one digest message instead, and
each line opens its full card.

The bot never submits applications and never contacts employers.

## Screenshots

_Coming soon._

<!-- docs/screenshots/card.png, docs/screenshots/digest.png, docs/screenshots/status.png -->

## Quick start with Docker Compose

Requirements: Docker with the Compose plugin.

```bash
git clone <this repository> job-scout && cd job-scout
cp .env.example .env
cp config.example.yaml config.yaml
cp profile.example.md profile.md
```

1. [Create a bot token](#create-the-bot-token) and put it in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Edit `config.yaml`: set `user`, enable the sources you want and adjust `filters`.
3. Start everything:

   ```bash
   docker compose up -d --build
   ```

4. [Find your chat ID](#find-your-chat-id), add it to `telegram.allowed_chat_ids` and restart:

   ```bash
   docker compose restart worker bot
   ```

Compose runs four services: `postgres`, a one-shot `migrate`, the `worker` that collects and filters,
and the `bot` that talks to Telegram. Follow the logs with `docker compose logs -f worker bot`.

On the first run of a source, postings without a publish date are stored quietly, so adding a board
does not flood your chat with its whole backlog. Dated postings are subject to `filters.max_age_days`.

### Create the bot token

1. Open a chat with [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow the prompts for a name and a username.
3. Copy the token it gives you into `.env`:

   ```dotenv
   TELEGRAM_BOT_TOKEN=123456:replace-with-your-token
   ```

Keep the token secret: anyone who has it controls the bot.

### Find your chat ID

Start the stack with `telegram.allowed_chat_ids: []`, open your bot in Telegram and send `/start`.
The bot replies with your chat ID. Add it to the config:

```yaml
telegram:
  allowed_chat_ids: [123456789]
```

The bot only answers chats on this list. Everyone else gets a "this bot is private" reply to `/start`
and silence otherwise.

## LLM scoring

With `scoring.enabled: true`, every job that passes the rule filter is scored by Claude before it
is sent. The card then shows the priority bucket, a fit score from 0 to 100, a one-line reason,
red flags (hours, location, pay, level, stack) and the detected stack. Priority and industry also
go to the tracker.

1. Put an Anthropic API key in `.env` as `ANTHROPIC_API_KEY`.
2. Fill in `profile.md` (start from [profile.example.md](profile.example.md)). It is gitignored.
3. Configure `scoring` in `config.yaml`: the model, your priority buckets with a definition each,
   optional industry labels and a daily budget.

How it behaves:

- **Budget.** Spend is computed from the token counts of every call and capped per calendar day in
  your time zone. When the cap is reached, jobs are sent unscored until midnight. `/status` shows
  today's spend.
- **Never blocks delivery.** If the API fails three times or the model declines a posting, the job
  is sent unscored.
- **Cached.** Each job is scored once. The instructions and your profile form a fixed prefix that
  is prompt-cached, so repeated calls pay mostly for the posting itself.
- **Threshold.** With `min_fit_score`, jobs scored below it are not sent; they stay in the database.
- **Prices.** Built in for current Claude models. For any other model id, set `scoring.pricing`.

## Notion tracker

By default _Add to tracker_ writes to a table in your own Postgres. To write to a Notion database
instead:

1. Create an integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
   with the _Read content_ and _Insert content_ capabilities, and copy its secret into `.env` as
   `NOTION_TOKEN`.
2. Open your database in Notion, choose **⋯ → Connections** and add the integration.
3. Copy the data source ID: database menu → **Manage data sources** → **Copy data source ID**.
4. Set `tracker.type: notion` and fill `tracker.notion` (see the commented block in
   `config.example.yaml`):
   - `properties` maps job fields to your property names. The adapter reads each property's type
     from Notion, so title, text, URL, select, multi-select, status, date, number and checkbox
     properties all work. Fields: `company`, `title`, `url`, `links`, `salary`, `location`,
     `work_format`, `employment`, `source`, `priority`, `status`, `industry`, `posted_at`,
     `added_at`.
   - `values` translates job values into your option names, for example
     `work_format: { remote: Remote, onsite: Office }`. For `source`, keys are source ids or types
     and may end with `*`: `{ 'rss:my-board-*': 'My Board', greenhouse: 'Company website' }`.
   - `defaults` sets fixed values on every new row, such as `status: 'To Apply'`.
   - `auto_number` fills a number property with the current maximum plus one.

The bot checks the mapping against the live database at startup and in `/status`. Before creating a
page it looks for an existing page with the same link, so tapping twice never makes two rows. A
value that is not an existing select option is skipped and listed on the card, unless
`create_select_options` is on. Properties you do not map are never written.

## Commands

| Command    | What it does                                                    |
| ---------- | --------------------------------------------------------------- |
| `/start`   | Confirms the chat is set up, or tells a new chat its ID         |
| `/help`    | Explains the buttons and commands                               |
| `/status`  | Source health, last run of each source, counts, worker liveness |
| `/filters` | Shows the active filter rules                                   |
| `/pause`   | Stops collecting and sending                                    |
| `/resume`  | Resumes after `/pause`                                          |

## Configuration

Everything is in one `config.yaml`, validated at startup. Unknown keys are rejected, so a typo fails
with the path of the offending key instead of being ignored:

```text
config.yaml is invalid:
  - telegram: unknown key "batch_treshold"
  - filters.hours.must_finish_by: expected a 24-hour time such as "19:00"
```

- **Full reference:** [docs/config-reference.md](docs/config-reference.md), generated from the schema.
- **Annotated example:** [config.example.yaml](config.example.yaml).
- **Check a file without starting anything:** `pnpm config:check path/to/config.yaml`.

Secrets live in `.env` and never in the config. `config.yaml`, `.env` and `profile.md` are
gitignored.

### How the filter decides

Each rule is optional. A posting is **dropped** when any rule fails, **flagged** when it is kept with
a remark shown on the card, and **passed** otherwise.

| Rule       | Drops when                                                                                         | Flags when                                             |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Age        | Published more than `max_age_days` ago                                                             |                                                        |
| Title      | An `exclude_any` keyword is present, or no `include_any` keyword is                                |                                                        |
| Seniority  | An excluded level is in the title, or a level is stated that you did not ask for                   | No level is stated                                     |
| Stack      | None of `required_any` is mentioned, or an `exclude_primary` language is in the title              | An excluded language features heavily in the text      |
| Employment | The type is not allowed                                                                            |                                                        |
| Location   | Restricted to countries or regions that exclude yours; on-site outside your cities; always-blocked | Location or work mode is not stated                    |
| Pay        | The top of the stated range is below your floor                                                    | Pay, currency rate or period is missing                |
| Hours      | A drop pattern matches, or stated hours start after `must_finish_by` in your time zone             | Stated hours run past your cutoff; a flag pattern hits |

Keywords match whole words, case-insensitively, and handle terms such as `c++`, `.net` and
`node.js`. Region names (`europe`, `eu`, `emea`, `latam`, ...) come from a built-in gazetteer that you
can extend with `filters.location.extra_aliases`.

## Development

Requirements: Node.js 22 and pnpm.

```bash
pnpm install
docker compose up -d postgres     # database only
cp .env.example .env              # DATABASE_URL already points at localhost
pnpm db:migrate
pnpm dev:worker                   # in one terminal
pnpm dev:bot                      # in another
```

| Script             | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `pnpm typecheck`   | TypeScript in strict mode                |
| `pnpm lint`        | ESLint and Prettier                      |
| `pnpm test`        | Vitest: unit and integration tests       |
| `pnpm build`       | Compile to `dist/`                       |
| `pnpm db:generate` | Create a migration after a schema change |
| `pnpm docs:config` | Regenerate the configuration reference   |

Tests need no network and no database server: the integration tests run the whole pipeline against
an in-process Postgres (PGlite), a stubbed network and a mocked Telegram API. All fixtures contain
made-up companies and postings.

### Project layout

```text
src/
  config/      Zod schema, YAML and env loading
  db/          Drizzle schema, client, stores
  http/        polite HTTP client: User-Agent, ETag cache, backoff, per-host throttle
  sources/     collectors: rss, greenhouse, ashby
  normalize/   Job shape; salary, location and hours parsers
  dedup/       canonical URL and fuzzy key
  filters/     rule filter with reason codes
  llm/         Claude client, pricing and daily budget
  scoring/     scoring prompt and the scorer queue
  pipeline/    fetch -> normalize -> dedup -> filter -> queue
  worker/      scheduler and worker entrypoint
  trackers/    tracker interface, Postgres and Notion trackers
  liveness/    "is this posting still open?" checks
  bot/         cards, buttons, commands, outbox
drizzle/       SQL migrations
```

The worker never talks to Telegram. It writes kept jobs to a `deliveries` table, and the bot sends
them. That gives one rate limiter and one place that decides between cards and a digest.

### Adding a source or a tracker

- [docs/adding-a-source.md](docs/adding-a-source.md)
- [docs/adding-a-tracker.md](docs/adding-a-tracker.md)

## Terms of service and ethics

job-scout is built to be a polite, low-volume reader of data that sites publish for this purpose.

- **Public feeds and APIs only.** RSS/Atom feeds and the public job board APIs of Greenhouse and
  Ashby. No HTML scraping of pages behind a login, no LinkedIn scraping, no CAPTCHA solving.
- **No auto-apply.** The bot never submits an application and never messages an employer. It
  prepares information; you act.
- **Identifies itself.** Every request carries a descriptive `User-Agent` (`job-scout/<version>`).
  Add a contact URL or address with `app.user_agent_contact` if you want site owners to be able to
  reach you. Nothing personal is sent unless you set it.
- **Light on servers.** Conditional requests (`ETag`, `Last-Modified`) avoid re-downloading unchanged
  boards, requests to one host are spaced out, and `429` or `5xx` answers trigger exponential backoff
  that honours `Retry-After`. A source that keeps failing is polled less often.
- **Your responsibility.** Check the terms of each feed or board you add, keep intervals reasonable
  and remove sources that ask not to be polled.
- **Your data stays with you.** Everything is stored in your own Postgres. Tokens and keys are read
  from the environment and are redacted from logs.

The optional Telegram channel reader (planned) will use **your own Telegram account** through a
session string. It will be off by default and documented separately, because a session string gives
full access to the account.

## Roadmap

1. _Prepare application_: answers to the posting's questions and a short cover letter from your
   `profile.md`, never inventing facts.
2. More sources: Lever, Himalayas, Remotive, RemoteOK, Jobicy.
3. Telegram channel reader through your own account.
4. Daily digest, `/stats`, `/search`, `/sources`, `/digest`.

## License

[MIT](LICENSE)
