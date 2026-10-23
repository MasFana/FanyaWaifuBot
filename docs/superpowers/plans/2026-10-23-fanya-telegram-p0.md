# Fanya Telegram P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build single-owner Fanya Telegram companion with durable memory, agenda care, and safe proactive chat.

**Architecture:** `TelegramChannel` blocks unknown senders before all persistence or LLM work, then hands accepted turns to a single-owner `Agent`. `MemoryService` owns SQLite plus FTS transactions. `HeartbeatEngine` claims eligible proactive work before agent wakeups. Post-turn extraction sees only stored owner text.

**Tech Stack:** Node.js LTS, TypeScript strict ESM, pnpm, SQLite/better-sqlite3 FTS5, grammY, Zod, OpenAI-compatible API, Node `node:test`, tsx.

**Spec:** `PRD.md`; `docs/superpowers/specs/2026-10-23-fanya-telegram-design.md`

## Global Constraints

- Use TypeScript strict ESM and pnpm. Keep runtime additions limited to `better-sqlite3`, `grammy`, `zod`, `openai`, and `dotenv`.
- Store every timestamp as epoch milliseconds (`INTEGER`). SQLite connection enables foreign keys and WAL.
- Reject unknown Telegram senders silently before database and LLM access.
- `TELEGRAM_OWNER_ID` config has priority. Existing first-claim data with another ID remains inaccessible.
- Use FTS5 lexical BM25 search; maintain `messages_fts` and `facts_fts` in same service transaction.
- No `eval`, `Function`, shell execution, public multi-user support, CLI chat adapter, burst buffer, approval keyboard, voice, vector DB, or deployment stack in P0.
- `Agent` allows six LLM/tool steps maximum and writes a tool result for every returned tool call.
- Post-turn extractor receives owner text only. Tool output, assistant output, and search results never become extraction input.
- Proactive messages obey quiet hours and maximum two unanswered messages. Reminder/follow-up claims must be atomic.
- Split each delivered response on blank lines and use injected typing delay of 1.5–3 seconds in production.

## Review Focus

- Configured owner changes after first claim: accept configured ID, silently drop old claimant, never migrate old data. Test in Task 4.
- Midnight-crossing quiet hours: `23:30`–`06:30` blocks spontaneous and greeting sends at `02:00`. Test in Task 9.
- Duplicate heartbeat execution/restart: only conditional claim winner delivers a reminder. Test in Task 9.
- Unsafe calculator payload: identifiers, property access, oversized expression, and division by zero return tool error without code execution. Test in Task 6.
- Malformed extractor response or past schedule: no fact/commitment write and successful agent reply remains intact. Test in Task 8.

---

## File Map

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.env.example` | Build, scripts, strict compiler, documented config. |
| `src/config.ts`, `src/core/types.ts`, `src/core/clock.ts` | Validated settings, shared contracts, real/frozen time seam. |
| `src/db/schema.sql`, `src/db/index.ts` | Schema and migration/connection lifecycle. |
| `src/memory/service.ts` | All persistent domain operations and FTS maintenance. |
| `src/llm/{provider,openai,fake}.ts` | Provider contract and live/fake adapters. |
| `src/tools/*` | Tool contract, registry, built-in datetime/calculator/search/schedule tools. |
| `src/core/{context,agent,writer,heartbeat}.ts` | Prompt build, bounded loop, extraction, proactive policy. |
| `src/channels/telegram.ts` | grammY owner guard, commands, delivery and lifecycle. |
| `src/main.ts` | Dependency wiring and graceful shutdown. |
| `harness/{guardrails,tool-guidance}.md` | Stable prompt safety and tool-use instructions. |
| `tests/**/*.test.ts` | Unit/integration suite with temporary DB, fake provider, frozen clock/channel. |

### Task 1: Foundation and Test Harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- Create: `src/config.ts`, `src/core/types.ts`, `src/core/clock.ts`
- Create: `tests/helpers.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces `loadConfig(env: NodeJS.ProcessEnv): AppConfig`, `Clock`, `SystemClock`, `FrozenClock`.

- [ ] **Step 1: Write config and frozen-clock failing tests**

```ts
assert.throws(() => loadConfig({}), /LLM_API_KEY/);
assert.equal(new FrozenClock(100).now(), 100);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/config.test.ts`
Expected: FAIL because modules/scripts do not exist.

- [ ] **Step 3: Add package scripts and strict foundation**

Create `dev`, `start`, `typecheck`, and `test` scripts. Implement Zod config with PRD defaults; require LLM and Telegram tokens for production composition, allow test overrides. Define shared LLM, tool, channel, and domain types.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/config.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 2: SQLite Schema and Migration

**Files:**
- Create: `src/db/schema.sql`, `src/db/index.ts`, `tests/db.test.ts`

**Interfaces:**
- Produces `openDatabase(path: string): Database.Database`, `migrate(db, clock): void`.

- [ ] **Step 1: Write failing migration/FTS test**

```ts
migrate(db, clock);
assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='facts'").get().n, 1);
assert.doesNotThrow(() => db.prepare("INSERT INTO facts_fts(content) VALUES ('kopi')").run());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/db.test.ts`
Expected: FAIL because database module is absent.

- [ ] **Step 3: Implement schema and idempotent migration**

Copy PRD §8 schema verbatim except add `proactive_events` table keyed by `user_id`, `kind`, `local_date` for daily greetings. Record schema version once. Enable foreign keys and WAL on every connection.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/db.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 3: Persistent Memory Service

**Files:**
- Create: `src/memory/service.ts`, `tests/memory.test.ts`

**Interfaces:**
- Consumes: `Database.Database`, `Clock`.
- Produces `MemoryService` with `claimOwner`, `resolveOwner`, `recordInbound`, `appendMessage`, `search`, `upsertFact`, `upsertCommitment`, `listActiveFacts`, `listPendingCommitments`, `forget`, and `exportOwner`.

- [ ] **Step 1: Write failing persistence tests**

```ts
const tea = memory.upsertFact(userId, { content: "Suka teh hijau", category: "preferensi", origin: "stated" });
assert.equal(memory.getFact(coffee.id)?.status, "replaced");
assert.equal(memory.search(userId, "liburan Bandung").messages[0]?.content, "Aku liburan ke Bandung");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/memory.test.ts`
Expected: FAIL because `MemoryService` is absent.

- [ ] **Step 3: Implement transactional persistence**

Generate IDs with `randomUUID`. Insert/replace facts by normalized category/content key; write FTS rows with message/fact insert or status change. Deduplicate inbound Telegram event before message processing. Upsert commitments by normalized title plus closest pending event time. `forget` searches facts and pending commitments, soft-deleting exactly one match.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/memory.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 4: Owner Lock and Telegram Command Surface

**Files:**
- Create: `src/channels/telegram.ts`, `tests/telegram-auth.test.ts`, `tests/telegram-commands.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `MemoryService`, `Clock`.
- Produces `TelegramChannel` with `start()`, `stop()`, `sendReply(userId, text)`, `sendProactive(userId, text)`, `setAgent(agent)`.

- [ ] **Step 1: Write failing owner and first-claim tests**

```ts
await harness.receive({ fromId: 99999, text: "halo" });
assert.equal(spy.agentRuns, 0);
assert.equal(memory.countMessages(), 0);
await harness.receive({ fromId: 123, text: "/start" });
assert.equal(memory.resolveOwner("telegram", "123")?.id, "123");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/telegram-auth.test.ts tests/telegram-commands.test.ts`
Expected: FAIL because channel is absent.

- [ ] **Step 3: Implement grammY adapter and native commands**

Guard every inbound update first. Configured ID is valid even when a different identity exists. Empty owner ID permits first `/start` only. Add `/memory`, `/agenda`, `/forget`, `/quiet`, and `/export` direct service responses. Inject Bot/update/delay seams for tests. Persist only accepted owner text and reset unanswered count.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/telegram-auth.test.ts tests/telegram-commands.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 5: LLM Provider Contracts

**Files:**
- Create: `src/llm/provider.ts`, `src/llm/openai.ts`, `src/llm/fake.ts`, `tests/llm.test.ts`

**Interfaces:**
- Produces `LLMProvider.complete(request: LLMRequest): Promise<LLMResponse>` and `FakeLLMProvider.enqueue(response)`.

- [ ] **Step 1: Write failing fake/retry tests**

```ts
fake.enqueue({ content: "hai", toolCalls: [] });
assert.equal((await fake.complete(request)).content, "hai");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/llm.test.ts`
Expected: FAIL because provider contracts are absent.

- [ ] **Step 3: Implement adapters**

Map OpenAI-compatible chat completions to internal messages/tools. Retry only 429, 5xx, and network errors up to three attempts with injected sleep. Fake queues deterministic success/failure responses and captures requests.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/llm.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 6: Tool Registry and Safe Built-ins

**Files:**
- Create: `src/tools/index.ts`, `src/tools/datetime.ts`, `src/tools/calculator.ts`, `tests/tools.test.ts`

**Interfaces:**
- Produces `ToolDefinition`, `ToolRegistry.execute(name, rawArguments, context)`, `createBuiltinTools(deps)`.

- [ ] **Step 1: Write failing datetime/calculator tests**

```ts
assert.equal(await tools.execute("utility_calculate", { expression: "(2 + 3) * 4" }, ctx), 20);
await assert.rejects(tools.execute("utility_calculate", { expression: "process.exit()" }, ctx));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/tools.test.ts`
Expected: FAIL because registry is absent.

- [ ] **Step 3: Implement validated tool registry**

Validate Zod arguments before invoking handler. Use bounded tokenizer/parser for calculator. Datetime returns owner-zone formatted date/time from injected clock. Support default export discovery from built tool directory, but construct built-ins explicitly for source/test composition.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/tools.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 7: Context Builder and Bounded Agent Loop

**Files:**
- Create: `src/core/context.ts`, `src/core/agent.ts`, `harness/guardrails.md`, `harness/tool-guidance.md`, `tests/agent.test.ts`

**Interfaces:**
- Consumes: `LLMProvider`, `MemoryService`, `ToolRegistry`, `TelegramChannel`, `Clock`.
- Produces `ContextBuilder.build(input): Promise<LLMMessage[]>`, `Agent.runInbound(event): Promise<void>`, `Agent.runWakeup(wakeup): Promise<AgentOutcome>`.

- [ ] **Step 1: Write failing agent loop tests**

```ts
fake.enqueue({ content: null, toolCalls: [{ id: "call-1", name: "utility_calculate", arguments: { expression: "2+2" } }] });
fake.enqueue({ content: "Empat, yang 😊", toolCalls: [] });
await agent.runInbound(inbound);
assert.match(channel.sent[0].text, /Empat/);
assert.equal(memory.toolEvent("call-1")?.status, "ok");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/agent.test.ts`
Expected: FAIL because agent/context modules are absent.

- [ ] **Step 3: Implement prompt and loop**

Load persona, guardrails, and tool guidance once. Build PRD §9 context with active facts, H-1 to H+3 agenda, summary, and last 20 messages. Persist agent run/messages/tool events. Execute at most six tool cycles and return structured failure tool output for bad calls. Deliver final multi-bubble reply; mark run failed on exhaustion/error.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/agent.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 8: Post-turn Fact, Mood, and Agenda Writer

**Files:**
- Create: `src/memory/writer.ts`, `src/tools/memory-search.ts`, `src/tools/schedule.ts`, `tests/writer.test.ts`

**Interfaces:**
- Produces `PostTurnWriter.enqueue(input): Promise<void>`, `createMemorySearchTool(memory)`, `createScheduleTools(memory, clock)`.

- [ ] **Step 1: Write failing extraction and schedule tests**

```ts
await writer.enqueue({ userId, ownerMessage: "Besok jam 10 aku presentasi proyek", messageId });
assert.equal(memory.listPendingCommitments(userId)[0]?.title, "Presentasi proyek");
assert.equal(memory.listPendingCommitments(userId)[0]?.remindAt, eventAt - 75 * 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/writer.test.ts`
Expected: FAIL because writer/tools are absent.

- [ ] **Step 3: Implement owner-only structured extraction**

Ask extractor provider for Zod-validated JSON facts, optional mood, and commitments. Pass only owner content. Ignore invalid JSON/past timestamps. Default missing reminder/follow-up times. Add FTS-backed memory search and schedule upsert/list tool definitions. Start writer after successful inbound final reply without blocking delivery.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/writer.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 9: Heartbeat and Proactive Guards

**Files:**
- Create: `src/core/heartbeat.ts`, `tests/heartbeat.test.ts`

**Interfaces:**
- Consumes: `MemoryService`, `Agent`, `Clock`, `AppConfig`.
- Produces `HeartbeatEngine.tick(): Promise<void>`, `HeartbeatEngine.start(): void`, `HeartbeatEngine.stop(): void`.

- [ ] **Step 1: Write failing proactive behavior tests**

```ts
clock.set(commitment.remindAt);
await heartbeat.tick();
assert.equal(agent.wakeups[0]?.triggerType, "agenda_reminder");
clock.set(twoAm);
await heartbeat.tick();
assert.equal(agent.wakeups.filter(x => x.triggerType === "spontaneous").length, 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/heartbeat.test.ts`
Expected: FAIL because heartbeat is absent.

- [ ] **Step 3: Implement due claims and social policy**

Claim due reminder/follow-up with conditional update before wakeup. Gate spontaneous and once-per-window greeting events by owner timezone, quiet range, idle duration, last proactive time, and unanswered count. Record actual proactive sends; skip token reverts claim. Ensure owner response resets unanswered count. Use unref interval and never overlap ticks.

- [ ] **Step 4: Run focused test and typecheck**

Run: `rtk pnpm test -- tests/heartbeat.test.ts && rtk pnpm typecheck`
Expected: PASS.

### Task 10: Composition, Lifecycle, and Full Acceptance Suite

**Files:**
- Create: `src/main.ts`, `tests/acceptance.test.ts`
- Modify: `package.json`, `.env.example`

**Interfaces:**
- Consumes all prior composition contracts.
- Produces executable `pnpm start` process with graceful `SIGINT`/`SIGTERM` shutdown.

- [ ] **Step 1: Write failing end-to-end fake acceptance tests**

```ts
await app.receiveOwner("Aku suka kopi hitam");
await app.receiveOwner("Sekarang aku ganti teh hijau");
assert.equal(app.memory.activeFacts(app.ownerId)[0]?.content, "Suka teh hijau");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk pnpm test -- tests/acceptance.test.ts`
Expected: FAIL because composition root is absent.

- [ ] **Step 3: Wire production dependencies and shutdown**

Load dotenv then config, open/migrate DB, instantiate services/tools/providers/channel/agent/heartbeat, and start Telegram long polling. On signal, stop heartbeat then channel then close DB. Add valid plain-URL `.env.example` and database ignore policy.

- [ ] **Step 4: Run full verification**

Run: `rtk pnpm test && rtk pnpm typecheck`
Expected: all PRD §12 tests and compiler pass.

- [ ] **Step 5: Review working tree and commit if repository exists**

Run: `rtk git status && rtk git diff`
Expected: only intended Fanya implementation files change. Do not initialize or commit a non-repository.

## Self-Review

- Coverage: Tasks 1–10 cover PRD foundation, agent loop, memory, heartbeat, Telegram, tools, commands, and automated tests. P1 debounce/approval deliberately excluded.
- Type consistency: `MemoryService`, `LLMProvider`, `ToolRegistry`, `Agent`, and `TelegramChannel` contracts are introduced before consumers.
- Review focus: Tasks 4, 6, 8, and 9 own all five listed edge cases.
- Proportion: Plan specifies contracts/tests and leaves bodies to executor.
