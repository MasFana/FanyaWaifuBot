# Fanya Telegram Companion Design

## Intent

Build private, single-owner Telegram companion from `PRD.md`. Owner gets warm Indonesian chat, durable recall, schedule care, and limited proactive messages. System must reject every untrusted Telegram sender before database or LLM work.

## Goals

- Strict TypeScript ESM service with SQLite persistence and FTS5 retrieval.
- One configured or first-claimed Telegram owner.
- LLM-driven chat/tool loop with bounded execution and test fake.
- Active facts, searchable messages/facts, and future commitments survive restarts.
- Heartbeat sends due reminders, follow-ups, or guarded spontaneous care.
- Each core behavior has fake-provider/frozen-clock test coverage.

## Non-goals

- No multi-user/public service, voice, vector DB, web UI, container/deployment stack, approval keyboard, or burst buffering in first implementation.
- No LLM request when no heartbeat trigger is eligible.

## Architecture

`TelegramChannel` authenticates and persists accepted inbound events, then calls `Agent.runInbound`. `HeartbeatEngine` finds and atomically claims due work, applies social guards, then calls `Agent.runWakeup`. Both paths serialize per owner through one in-process promise queue.

`MemoryService` owns every SQLite write/read and explicitly maintains FTS5 rows in same transaction. `ContextBuilder` reads harness markdown, owner state, active facts, near agenda, summary, and recent messages. `Agent` runs at most six LLM/tool cycles, persists every assistant/tool message, always creates a tool response for every returned call, then sends final text through channel delivery.

`PostTurnWriter` receives only stored owner text and uses extractor-model structured JSON. It writes facts, mood, and commitments asynchronously; malformed output does nothing. `HeartbeatEngine` owns reminder/follow-up claim marks so a restart or overlapping tick cannot duplicate proactive delivery.

## Decisions

- Package manager: pnpm. Test runner: Node built-in `node:test` with `tsx`; no test framework dependency.
- Runtime dependencies: `better-sqlite3`, `grammy`, `zod`, `openai`, `dotenv`. Dev dependencies: TypeScript, `tsx`, `@types/node`, `@types/better-sqlite3`.
- Schema copied from PRD, with explicit transactional FTS maintenance. UUID uses `crypto.randomUUID()`.
- Timestamps are epoch milliseconds. Timezone conversion uses `Intl.DateTimeFormat`; quiet hours support normal and midnight-crossing ranges.
- Configured `TELEGRAM_OWNER_ID` wins. If database first-claim differs from configured ID, configured ID is accepted and old owner data remains inaccessible; no migration runs. Empty setting permits exactly first `/start` to claim owner; subsequent foreign updates silently drop. Claimed owner remains valid across restarts even if environment value stays empty.
- `memory_search` is lexical FTS5 BM25 search, limited to 10 results. User prompt may direct use; tool guidance documents this truthfully.
- Calculator parses only numbers, parentheses, `+ - * / % **`, with bounded expression length/depth. No `eval`, `Function`, shell, or network execution.
- LLM provider uses OpenAI-compatible Chat Completions tool calls. Retry only retryable 429/5xx/network failures with bounded exponential backoff. Fake provider queues deterministic responses.
- Post-turn extraction uses strict Zod output format. Facts with same normalized category/key conflict: mark prior active fact `replaced`, then insert new fact. Initial key is normalized first clause/content; no heuristic deletion outside extractor output.
- Schedule extractor accepts only explicit future timestamps from model; service rejects timestamps at or before clock time. Default reminder is event minus 75 minutes and follow-up event plus 150 minutes when omitted.
- Due commitment claim uses conditional `UPDATE ... WHERE reminded_at IS NULL` / `followed_up_at IS NULL` before delivery. If LLM returns `[SKIP_PROACTIVE]`, claim is reverted so eligible next tick can retry.
- Spontaneous care: only outside quiet hours, after `SPONTANEOUS_IDLE_HOURS`, no more than `MAX_UNANSWERED_PROACTIVE`, and at least idle-hours since last proactive send. Separate once-per-window morning and night greetings use persisted daily state and same quiet/backoff gates. Owner inbound message resets unanswered count.
- Native commands: `/start`, `/memory`, `/agenda`, `/forget <topik>`, `/quiet <mulai> <selesai>`, `/export`. Commands bypass LLM where direct database response is sufficient. `/forget` searches facts and pending commitments; one result soft-deletes it, multiple results return numbered candidates and require exact topic refinement.
- Commitment upsert identifies an existing pending commitment by normalized title plus closest event time within 24 hours. Owner cancellation marks that commitment `cancelled`; a changed time updates it; a new recurring occurrence inserts a new row.
- `sendProactive` and ordinary reply delivery split text on blank lines and send each nonempty bubble after Telegram typing action plus randomized 1.5–3 second delay. Tests inject delay function to avoid waits.
- Tool extensions export a `ToolDefinition` default from `src/tools/*.ts`; loader scans compiled JavaScript directory at runtime. Built-ins use static registration in tests/source to avoid TS runtime module discovery ambiguity. Adding a compiled tool module requires no core change.

## Boundaries

| Unit | Responsibility |
|---|---|
| `src/config.ts` | Parse environment; safe defaults; reject invalid deployment config. |
| `src/db/*` | Schema migration and SQLite lifecycle. |
| `src/memory/*` | Persistent owner, conversation, messages, facts, FTS, commitments, export. |
| `src/llm/*` | Provider contracts, OpenAI adapter, deterministic fake. |
| `src/tools/*` | Validated read/write capabilities exposed to LLM. |
| `src/core/*` | Context, agent execution, post-turn writing, heartbeat. |
| `src/channels/*` | CLI and grammY integration/delivery only. |
| `src/main.ts` | Composition root and graceful SIGINT/SIGTERM shutdown. |

## Safety and Failure Behavior

- Unknown Telegram updates are silent and make zero DB/LLM writes.
- Dedupe Telegram messages with `inbound_events` before processing.
- Tool schema failure returns structured tool error; agent continues until step limit.
- LLM/tool/delivery errors mark agent run failed, log structured error, and do not crash polling loop.
- Extraction failure is logged and isolated from successful chat reply.
- User-provided tool output never enters extraction input.
- Tool calls carrying external side effects are not shipped in P0; no approval flow exists until P1.

## Acceptance

- `pnpm typecheck` passes.
- Automated tests cover PRD §12 cases: owner lock, first claim, fact replacement, FTS, schedule extraction, reminder/follow-up, quiet/backoff.
- Telegram starts long polling and stops cleanly on `SIGINT`/`SIGTERM`.
- Commands and proactive delivery work with no live LLM under fake tests.

## Builder Calls

- Add `harness/guardrails.md` and `harness/tool-guidance.md` with grounded emotional safety and precise tool-use rules.
- CLI conversation adapter remains out of scope. CLI diagnostics consist only of process logs and startup/shutdown output. P1 burst debouncing and approval keyboard remain deferred. Add only after P0 stable.
