# Fanya Deasherian — Telegram Companion

Proactive, context-aware AI girlfriend companion bot for Telegram. Node.js + TypeScript (ESM), SQLite (FTS5), `grammY`, OpenAI-compatible LLM.

Single-owner: only the locked Telegram ID is served. Everything else is silently dropped.

See `PRD.md` for the full product spec.

---

## Requirements

| Tool | Version |
|---|---|
| Node.js | LTS (20+ recommended) |
| pnpm | 8+ (repo uses `pnpm-lock.yaml` + workspace) |

`better-sqlite3` is a native module. On a clean machine you need a C/C++ toolchain so `pnpm install` can build it:

- **Windows**: install "Desktop development with C++" via Visual Studio Build Tools.
- **macOS**: `xcode-select --install`
- **Debian/Ubuntu**: `sudo apt install build-essential python3`

---

## Install

```bash
pnpm install
```

## Configure

```bash
cp .env.example .env
```

Fill `.env` (see the reference table below). Then run one of:

```bash
pnpm dev      # tsx watch, hot reload (development)
pnpm start    # runs compiled dist/ (production) — needs `pnpm build` first
```

---

## Environment variables

Loaded from `.env` via `dotenv/config`. Validated by Zod at startup (`src/config.ts`) — an invalid value aborts the process with a clear error.

### LLM (OpenAI-compatible)

| Variable | Default | Rules | Meaning |
|---|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | valid URL | Chat-completions endpoint base. Any OpenAI-compatible gateway works. |
| `LLM_API_KEY` | *(empty)* | **required** unless `NODE_ENV=test` | API key sent as bearer token. |
| `LLM_MODEL` | `gpt-4o` | non-empty | Model used for the chat/agent loop. |
| `LLM_EXTRACTOR_MODEL` | `gpt-4o-mini` | non-empty | Model used by the async post-turn extractor (facts, mood, schedule). A cheaper/faster model is fine. |

### Telegram

| Variable | Default | Rules | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(empty)* | **required** unless `NODE_ENV=test` | Token from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_OWNER_ID` | *(empty)* | digits only (`^\d*$`) or empty | Locked owner's numeric Telegram user ID. **Leave empty for the first `/start` to claim the owner, then set it and restart** to lock permanently. |

> Security: if `TELEGRAM_OWNER_ID` is empty and the bot is reachable, the **first** `/start` claims ownership. Set the ID before exposing the bot to anyone else.

### Owner profile & heartbeat

| Variable | Default | Rules | Meaning |
|---|---|---|---|
| `OWNER_DISPLAY_NAME` | `Sayang` | non-empty | How Fanya knows the owner. |
| `OWNER_TIMEZONE` | `Asia/Jakarta` | valid IANA zone | Used for time awareness, quiet hours, greetings. |
| `QUIET_HOURS_START` | `23:30` | `HH:mm` (00:00–23:59) | Start of do-not-disturb window. |
| `QUIET_HOURS_END` | `06:30` | `HH:mm` | End of quiet window. May cross midnight. Lifecycle default; override per user with `/quiet`. |
| `HEARTBEAT_INTERVAL_MS` | `60000` | positive int (ms) | How often the proactive engine ticks. |
| `SPONTANEOUS_IDLE_HOURS` | `6` | positive number | Idle hours before a spontaneous "miss you" check-in. |
| `MAX_UNANSWERED_PROACTIVE` | `6` | non-negative int | Max consecutive proactive messages with no reply before backing off. |

### Reply behaviour

| Variable | Default | Rules | Meaning |
|---|---|---|---|
| `REPLY_DEBOUNCE_MS` | `8000` | non-negative int (ms) | Wait this long for a quiet gap before replying, merging a burst of owner messages into one turn. `0` disables debouncing (reply per message). |
| `REPLY_DEFER_EXTRA_MS` | `60000` | non-negative int (ms) | Extra delay when Fanya is "focused" (living-state), before replying. |
| `REPLY_MAX_BUBBLES` | `4` | positive int | Max Telegram bubbles per reply; overflow is merged into the last bubble. |
| `FOCUS_DEFER_THRESHOLD` | `0.6` | 0–1 | Focus drive threshold above which replies get deferred. |
| `NGAMBEK_ENABLED` | `false` | `true`/`false` (case-insensitive) | Enables the "ngambek" (playful pouting) behaviour in the mood engine. |

### Storage & logs

| Variable | Default | Rules | Meaning |
|---|---|---|---|
| `DATABASE_PATH` | `./data/fanya.db` | non-empty | SQLite file. Parent dir is created on start. WAL mode. |
| `LOG_LEVEL` | `info` | `debug`\|`info`\|`warn`\|`error` | Log verbosity. |

### Test-only

| Variable | Meaning |
|---|---|
| `NODE_ENV=test` | Relaxes `LLM_API_KEY` / `TELEGRAM_BOT_TOKEN` requirements so the test suite runs offline. Not for production. |

---

## Example `.env`

```ini
# --- LLM (OpenAI-compatible) ---
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-proj-your-key-here
LLM_MODEL=gpt-4o
LLM_EXTRACTOR_MODEL=gpt-4o-mini

# --- Telegram ---
TELEGRAM_BOT_TOKEN=1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_OWNER_ID=

# --- Owner & heartbeat ---
OWNER_DISPLAY_NAME=Bub
OWNER_TIMEZONE=Asia/Jakarta
QUIET_HOURS_START=23:30
QUIET_HOURS_END=06:30
HEARTBEAT_INTERVAL_MS=60000
SPONTANEOUS_IDLE_HOURS=6
MAX_UNANSWERED_PROACTIVE=6

# --- Reply behaviour ---
REPLY_DEBOUNCE_MS=8000
REPLY_DEFER_EXTRA_MS=60000
REPLY_MAX_BUBBLES=4
FOCUS_DEFER_THRESHOLD=0.6
NGAMBEK_ENABLED=false

# --- Storage & logs ---
DATABASE_PATH=./data/fanya.db
LOG_LEVEL=info
```

---

## First-run onboarding (claim the owner)

1. Start the bot with `TELEGRAM_OWNER_ID` empty:
   ```bash
   pnpm dev
   ```
2. In Telegram, open your bot and send `/start`.
3. The bot claims your ID and replies with it: `id telegram kamu ... 2003761509`.
4. Put that number into `.env`:
   ```ini
   TELEGRAM_OWNER_ID=2003761509
   ```
5. Restart the bot. The owner is now locked; all other IDs are ignored.

---

## Commands

| Command | Effect |
|---|---|
| `/start` | Connection status + greeting (also the first-claim entrypoint). |
| `/memory` | Lists facts Fanya remembers about you. |
| `/agenda` | Lists pending schedules/reminders. |
| `/forget <topik>` | Deletes a matching fact or schedule. |
| `/quiet <mulai> <selesai>` | Sets personal quiet hours, e.g. `/quiet 23:30 06:30`. |
| `/export` | Sends a JSON backup of your memory as a document. |

---

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | `tsx watch src/main.ts` — dev with hot reload. |
| `pnpm start` | `node dist/src/main.js` — run the compiled build. |
| `pnpm build` | `tsc` + copies `schema.sql` into `dist/`. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm test` | Runs the full test suite (`tsx --test`). |
| `pnpm db:clean` | Deletes `data/fanya.db{,-shm,-wal}`. **Destroys all memory.** |

---

## Data & backup

- Everything lives in one SQLite file (`DATABASE_PATH`), plus WAL sidecar files.
- Back up: stop the bot, copy the `.db`, `.db-wal`, `.db-shm` files together. Or use `/export` in Telegram for a JSON snapshot.
- Reset: `pnpm db:clean` (irreversible).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `LLM_API_KEY is required` / `TELEGRAM_BOT_TOKEN is required` | Fill them in `.env`, or set `NODE_ENV=test` for offline tests only. |
| `TELEGRAM_OWNER_ID must contain only digits` | Use the numeric ID only (no `@username`), or leave it empty. |
| `OWNER_TIMEZONE must be a valid IANA timezone` | Use e.g. `Asia/Jakarta`, `Europe/London`. |
| `better-sqlite3` fails to build on `pnpm install` | Install a C++ toolchain (see Requirements) then reinstall. |
| Bot ignores your messages | You are not the locked owner, or `TELEGRAM_OWNER_ID` mismatches your ID. |
| Bot replies are duplicated/long | Lower `REPLY_MAX_BUBBLES`, raise `REPLY_DEBOUNCE_MS`, or disable the focus defer (`FOCUS_DEFER_THRESHOLD=1`). |
