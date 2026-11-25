# job-scout

A self-hosted Telegram bot that finds fresh job postings, filters them against rules you define and
sends each match to you as a card you can act on in one tap.

The goal is speed: a matching job should reach you within minutes of being published.

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
   - **Prepare application** (optional) drafts answers to the posting's application questions and a
     short cover letter from your `profile.md`, ready to copy.

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

### Sources

| Source     | What it reads                                           | Polling          |
| ---------- | ------------------------------------------------------- | ---------------- |
| RSS / Atom | Any job board feed URL, e.g. a saved search             | your interval    |
| Greenhouse | Public board API of each company slug you list          | your interval    |
| Ashby      | Public posting API of each company slug                 | your interval    |
| Lever      | Public postings API of each site name (EU instance too) | your interval    |
| Himalayas  | Remote jobs search API, one request per query           | at least hourly  |
| Remotive   | Remote jobs API, one request per run, filtered locally  | at least 6 hours |
| RemoteOK   | Remote jobs API, one request per tag                    | at least hourly  |
| Jobicy     | Remote jobs API, one request per run, filtered locally  | at least hourly  |

The minimum intervals follow each provider's published guidance and cannot be lowered in config.
Remotive shows jobs 24 hours after publication and Jobicy about 3 hours after, by their own design.
Cards credit these boards by name and link to their page, as their terms require.

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

## Prepare application

With `application.enabled: true` (and `ANTHROPIC_API_KEY` plus `profile.md`), cards get a
**📝 Prepare application** button, also kept after a job is added to the tracker.

- **Questions.** For Greenhouse postings the bot loads the real application questions from the
  public board API, including the options of select questions. The public Ashby and Lever APIs and
  RSS feeds do not publish questions, so for those you get the cover letter only.
- **Only your facts.** The draft uses only what `profile.md` states. When the profile does not
  answer a question, the answer is left empty and marked ✏️ with what you need to supply.
- **Left to you.** Name, email, phone, resume uploads and equal-opportunity or demographic
  questions are never drafted; the draft lists them so you do not miss them.
- **Copyable.** Each answer comes in its own code block, which Telegram copies with one tap.
- **Cost.** One call per job; a second tap shows the stored draft for free. Drafts count against
  `scoring.daily_budget_usd`.
- **Nothing is sent anywhere.** The bot never submits the application.

## Telegram channels

Many jobs are posted only in Telegram channels. Bots cannot read other people's channels, so this
source signs in with **your own Telegram account** and reads the channels you list. It is off by
default.

> **Read this first.** The session string gives full access to your Telegram account, like a
> password. Keep it only in `.env`, never commit it, and if it leaks, end the session in Telegram
> under **Settings → Devices**. The reader only fetches channel history: it never sends messages,
> joins channels or reacts. Telegram may still rate-limit or restrict accounts that automate
> heavily; keep the channel list and interval reasonable.

1. Create an app at [my.telegram.org/apps](https://my.telegram.org/apps) and put its `api_id` and
   `api_hash` in `.env` as `TG_API_ID` and `TG_API_HASH`.
2. Create the session string once, interactively:

   ```bash
   pnpm tg:login
   # or, with Docker: docker compose run --rm -it worker node dist/tools/telegram-login.js
   ```

   Enter your phone number, the login code and your two-step password if you have one, then copy
   the printed `TG_SESSION=...` line into `.env`.

3. Enable the source:

   ```yaml
   sources:
     telegram_channels:
       enabled: true
       channels: [example_jobs, another_channel] # usernames, with or without "@"
       posts_per_run: 30
   ```

Each post is read as one job: the title, company, location and pay come from labelled lines
("Position:", "Company:", "Location:", "Salary:" and their Ukrainian and Russian equivalents) or
from a "Title at Company" header. The apply link is the first non-Telegram link in the post, or the
post itself. Posts that do not look like job postings are skipped. Free text is less precise than
an ATS API; with LLM scoring on, the score and red flags make up for most of it.

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

| Command           | What it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `/start`          | Confirms the chat is set up, or tells a new chat its ID            |
| `/help`           | Explains the buttons and commands                                  |
| `/status`         | Source health, last run of each source, counts, tracker, LLM spend |
| `/digest`         | Summary of the last 24 hours: counts, top picks, failing sources   |
| `/search <words>` | Stored jobs whose title, company or description contain every word |
| `/stats`          | Found, kept, dropped by reason, tracked, rejected by reason        |
| `/sources`        | Turn individual sources on or off with buttons                     |
| `/filters`        | Shows the active filter rules                                      |
| `/pause`          | Stops collecting and sending                                       |
| `/resume`         | Resumes after `/pause`                                             |

With `telegram.digest.enabled: true`, the same digest as `/digest` arrives every day at
`telegram.digest.time` in your time zone. It is sent once per day, also across restarts.

Sources switched off with `/sources` stay off until you switch them on again; sources disabled in
`config.yaml` do not appear there.

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
  sources/     collectors: rss, greenhouse, ashby, lever, himalayas, remotive, remoteok, jobicy,
               telegram channels
  tools/       one-off tools such as the Telegram login
  normalize/   Job shape; salary, location and hours parsers
  dedup/       canonical URL and fuzzy key
  filters/     rule filter with reason codes
  llm/         Claude client, pricing and daily budget
  scoring/     scoring prompt and the scorer queue
  applications/ application questions and drafts
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

- **Public feeds and APIs only.** RSS/Atom feeds, the public job board APIs of Greenhouse, Ashby and
  Lever, and the public APIs of Himalayas, Remotive, RemoteOK and Jobicy. No HTML scraping of pages
  behind a login, no LinkedIn scraping, no CAPTCHA solving.
- **Provider terms are built in.** Remotive is polled at most every 6 hours (it asks for at most 4
  requests a day); Himalayas, RemoteOK and Jobicy at most hourly. Their jobs are shown with a link
  to their page and their name, as their terms ask, and are only sent to you, never republished.
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

The optional Telegram channel reader uses **your own Telegram account** through a session string.
It is off by default, read-only, and documented in [Telegram channels](#telegram-channels), because
a session string gives full access to the account.

## License

[MIT](LICENSE)
