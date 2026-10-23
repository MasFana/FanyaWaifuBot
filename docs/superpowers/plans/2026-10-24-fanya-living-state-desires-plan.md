# Fanya Living State & Desires Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fanya act from an evolving internal state (own activity, drives, affection, consistent ngambek) so she feels alive: replies per turn (not per message), can be busy/brief, can push back, and initiates on her own.

**Architecture:** One owner turn = one debounced burst flush in `TelegramChannel`, running a single `Agent` turn. A deterministic `LivingState` (extends `PersonaState`) ticks on context-build and heartbeat, advancing a solo activity and drives; it is rendered as a natural cue. Code enforces only coarse gates (defer-vs-reply, anti-flood cap, proactive rems); tone/length/stance are the model's call from the cue.

**Tech Stack:** TypeScript (ESM, Node 24), better-sqlite3, node:test, zod. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-fanya-living-state-desires-design.md`

## Global Constraints

- No new npm dependency.
- ESM only: relative imports end in `.js`.
- Tests: `node:test` + `node:assert/strict`; DB tests use `openDatabase(":memory:")` + `migrate(database, clock)` + `FrozenClock`; heavy setup lives in `tests/helpers.ts`.
- Do NOT change the 6 known pre-existing failures: `tests/acceptance.test.ts:40,76,96`, `tests/telegram-auth.test.ts:95`, `tests/telegram-commands.test.ts:50,109`.
- `pnpm typecheck` clean after every task.
- Never edit `data/fanya.db` while the bot runs; tests never touch it.
- Persona keeps v2 de-anchoring: no quotable first-person example strings.
- Guardrail line (spec §10.3): Fanya may claim her OWN solo inner life; must not claim shared/owner reality or external actions beyond memory/tool.

## Config defaults (initial, tune later)

- `REPLY_DEBOUNCE_MS` = 4000
- `REPLY_DEFER_EXTRA_MS` = 60000
- `REPLY_MAX_BUBBLES` = 4 (anti-flood cap, replaces the removed word-count budget)
- `FOCUS_DEFER_THRESHOLD` = 0.6
- `NGAMBEK_ENABLED` = false (log-only first, per spec C5)

## Review Focus

1. Burst containing a command (`/start` amid chat) — command must flush the pending burst first, then run immediately; wrong loses or reorders the burst.
2. Owner message while activity active + high focus — must defer, but must still reply eventually (no permanent silence).
3. Corrupt/absent/old-shape `settings_json` — `parseLivingState` returns defaults, never throws, cue has no `NaN`/`Infinity`.
4. Technical/link turn at high focus — defer changes timing only; content still delivered fully when it runs.
5. Initiative vs rems — proactive from drives must respect `quietHours` + `maxUnansweredProactive` and never double-fire with the daily greeting.

---

### Task 1: Turn aggregation (debounce burst → one reply)

**Files:**
- Modify: `src/config.ts` (add `replies.debounceMs`, `replies.deferExtraMs`, `replies.maxBubbles`, `replies.focusDeferThreshold`, `replies.ngambekEnabled`)
- Modify: `src/core/types.ts` (`Channel.flushPending?`)
- Modify: `src/channels/telegram.ts` (buffer + timer in `receive`; `flushPending`; `deliver` cap from config)
- Modify: `src/core/heartbeat.ts` (accept `flush` hook; call before greeting/wake)
- Modify: `src/main.ts` (wire config + heartbeat flush)
- Modify: `tests/helpers.ts` (`createTestConfig` replies block + `debounceMs: 0`)
- Test: `tests/telegram-turn.test.ts` (new), `tests/config.test.ts`

**Interfaces:**
- Consumes: existing `OwnerQueue`, `TelegramChannel.receive`.
- Produces:
  - `interface RepliesConfig { debounceMs: number; deferExtraMs: number; maxBubbles: number; focusDeferThreshold: number; ngambekEnabled: boolean }`
  - `AppConfig.replies: RepliesConfig`
  - `TelegramChannel.flushPending(userId?: string): Promise<void>`
  - `Channel.flushPending?(userId?: string): Promise<void>`
  - `HeartbeatEngine` constructor gains 6th arg `flush?: (userId: string) => Promise<void>`

- [ ] **Step 1: Write failing test** — `tests/telegram-turn.test.ts`

```ts
// A burst of 3 owner messages within the debounce window produces exactly one agent turn
// whose inbound text contains all three, and three stored user messages.
```

Assert: after `receive("makan pedes")`, `receive("kek")`, `receive("jir")` (no touch in between), one `runInbound` with text joined; `memory.exportOwner(owner).messages.filter(role user)` includes all 3; and a `/start` burst flushes chat first then runs the command immediately.

- [ ] **Step 2: Run test, expect FAIL** — `pnpm exec tsx --test tests/telegram-turn.test.ts` (agent called 3x / text not joined).

- [ ] **Step 3: Implement**
  - `src/config.ts`: add env fields `REPLY_DEBOUNCE_MS`, `REPLY_DEFER_EXTRA_MS`, `REPLY_MAX_BUBBLES`, `FOCUS_DEFER_THRESHOLD`, `NGAMBEK_ENABLED` (zod, defaults above); expose `replies`.
  - `src/channels/telegram.ts`: per-owner `pending: Map<string, { texts: string[]; ids: string[]; timer?: NodeJS.Timeout }>`. `receive` (non-command) appends the raw text and (re)starts `setTimeout(flush, debounceMs)`; `recordInbound`/reset-count unchanged. Command path calls `await this.flushPending(owner.id)` first. `flushPending` clears timer, joins buffered texts with `\n`, calls one `agent.runInbound({ ..., text: joined, storedMessageId: lastMessage.id })`. Inject a `schedule`/timer seam so tests with `debounceMs: 0` flush synchronously via `flushPending`.
  - `deliver`: replace `defaultMaxBubbles` const with `config.replies.maxBubbles`.
  - `HeartbeatEngine`: new optional `flush`; `runSocial`/`wake` call it before wake.
  - `main.ts`: pass `config.replies`; construct heartbeat with `(userId) => channel.flushPending(userId)`.

- [ ] **Step 4: Run tests, expect PASS** — `pnpm exec tsx --test tests/telegram-turn.test.ts tests/telegram-commands.test.ts tests/config.test.ts`.

- [ ] **Step 5: Commit** `feat: debounce owner burst into one turn`

---

### Task 2: Persona — remove rigid shape rules, grant agency

**Files:**
- Modify: `harness/persona.md`
- Test: `tests/persona.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `persona.md` free of fixed-bubble/percentage rules; contains literal markers `putuskan sendiri`, `boleh diam`, `boleh nolak`.

- [ ] **Step 1: Write failing test** — append to `tests/persona.test.ts`

```ts
test("persona grants agency and drops fixed bubble rules", async () => {
  const persona = await readFile("harness/persona.md", "utf8");
  assert.doesNotMatch(persona, /maksimum 3 balon|~30% balasan|maksimum 3 bubble/u);
  assert.match(persona, /putuskan sendiri/u);
  assert.match(persona, /boleh (diam|nolak)/u);
});
```

- [ ] **Step 2: Run test, expect FAIL** — `pnpm exec tsx --test tests/persona.test.ts`.

- [ ] **Step 3: Rewrite the shape section of `harness/persona.md`** — drop fixed counts/percentages; add: "putuskan sendiri jumlah & panjang balon dari konteks; boleh diam/singkat/tunda kalau lagi fokus; boleh nolak/beda pendapat sesuai prinsipmu." Keep de-anchoring and the emoji/vocab lists.

- [ ] **Step 4: Run test, expect PASS**.

- [ ] **Step 5: Commit** `refactor: persona grants agency, drops fixed bubble rules`

---

### Task 3: LivingState — activity + deterministic tick

**Files:**
- Modify: `src/core/persona-state.ts` (add `activity`, `drives`; zod defaults)
- Create: `src/core/living-state.ts`
- Test: `tests/living-state.test.ts` (new), `tests/persona-state.test.ts`

**Interfaces:**
- Consumes: `PersonaState`.
- Produces:
  - `interface Activity { name: string; endsAt: number }`
  - `interface Drives { wantCompany: number; wantToShare: number; focus: number; boundary: number }`
  - `PersonaState` gains `activity: Activity | null`, `drives: Drives`
  - `const activityPool: readonly string[]`
  - `tickLivingState(state: PersonaState, input: { now: number; lastUserMessageAt: number | null; seed: string }): PersonaState`
  - `renderStateCue(state: PersonaState, mood: MoodState): string`

- [ ] **Step 1: Write failing tests** — `tests/living-state.test.ts`

```ts
// old-shape settings_json parses to defaults (activity null, drives zeroed), no throw
// tick with no activity picks one from pool, endsAt > now, deterministic for same seed
// tick past endsAt clears activity and raises wantToShare
// long silence raises wantCompany (clamped 0..1); recent owner activity lowers it
// renderStateCue contains no NaN/Infinity for default state
```

- [ ] **Step 2: Run tests, expect FAIL** — module not found.

- [ ] **Step 3: Implement**
  - `persona-state.ts`: extend `PersonaState` + zod schema with `activity` (nullable object) and `drives` (object of 4 numbers); defaults keep old json valid.
  - `living-state.ts`: `activityPool` (~5 Indonesian solo activities); deterministic RNG from `seed` (hash of seed + day bucket); `tickLivingState` advances activity selection/expiry and drive dynamics (linear formulas with named constants, clamped `[0,1]`); `renderStateCue` returns a natural Indonesian sentence combining activity + energy + notable drives (never numeric when finite-guarded).

- [ ] **Step 4: Run tests, expect PASS** — `pnpm exec tsx --test tests/living-state.test.ts tests/persona-state.test.ts`.

- [ ] **Step 5: Commit** `feat: living state with activity and deterministic tick`

---

### Task 4: Render living cue in context (replace static mood line)

**Files:**
- Modify: `src/core/context.ts` (tick state before rendering; replace `Suasana hati sekarang:` line with `renderStateCue`)
- Modify: `src/memory/service.ts` (persist ticked state)
- Test: `tests/agent.test.ts` (context block assertion), `tests/context` coverage via existing

**Interfaces:**
- Consumes: `tickLivingState`, `renderStateCue`, `computeMood`.
- Produces: `ContextBuilder.build` persists the ticked `LivingState` and renders `Keadaan sekarang: <cue>` plus `Keinginan: <drives>`.

- [ ] **Step 1: Write failing test** — extend `tests/agent.test.ts` context test: after `build`, prompt contains `Keadaan sekarang:` and `Keinginan:` and no `NaN`.

- [ ] **Step 2: Run test, expect FAIL**.

- [ ] **Step 3: Implement** in `context.ts`: `const living = tickLivingState(personaState, { now, lastUserMessageAt: state.lastUserMessageAt, seed: exported.owner.id }); this.memory.setPersonaState(input.userId, living);` then render `renderStateCue(living, mood)` in the dynamic block (keep anti-repeat line).

- [ ] **Step 4: Run tests, expect PASS** — `pnpm exec tsx --test tests/agent.test.ts`.

- [ ] **Step 5: Commit** `feat: render living state cue in prompt`

---

### Task 5: Decision gate — defer vs reply (busy/focus)

**Files:**
- Modify: `src/core/living-state.ts` (`decideReply`)
- Modify: `src/core/agent.ts` (runInbound consults gate; skip LLM call when deferring inbound? no — defer = timing)
- Modify: `src/channels/telegram.ts` (flush awaits `delay(deferExtraMs)` when focused, then runs turn)
- Test: `tests/living-state.test.ts`, `tests/telegram-turn.test.ts`

**Interfaces:**
- Consumes: `PersonaState`, `RepliesConfig`.
- Produces: `decideReply(state: PersonaState, input: { focusThreshold: number }): "reply" | "defer"`.

- [ ] **Step 1: Write failing tests**
  - `living-state.test.ts`: focus ≥ threshold + active activity → `"defer"`; else `"reply"`.
  - `telegram-turn.test.ts`: with seeded high-focus state, flush calls `delay(REPLY_DEFER_EXTRA_MS)` exactly once before the agent turn; with low focus it does not.

- [ ] **Step 2: Run tests, expect FAIL**.

- [ ] **Step 3: Implement**: `decideReply` reads `state.activity !== null && state.drives.focus >= input.focusThreshold`. In flush, `if (decideReply(living, { focusThreshold: config.replies.focusDeferThreshold }) === "defer") await this.delay(config.replies.deferExtraMs);` before `runInbound`. Defer affects timing only; content untouched.

- [ ] **Step 4: Run tests, expect PASS**.

- [ ] **Step 5: Commit** `feat: focus-based reply deferral`

---

### Task 6: Friction — boundaries and consistent ngambek

**Files:**
- Modify: `src/core/living-state.ts` (boundary rise/decay; driving ngambek)
- Modify: `src/core/mood.ts` (ngambek from `drives.boundary` + config flag; reconciliation: persists past one apology)
- Modify: `src/config.ts` (`replies.ngambekEnabled` already added; wire into computeMood via param)
- Modify: `harness/persona.md` (boundary/principle rule), `harness/guardrails.md` (fiction line §10.3)
- Test: `tests/mood.test.ts`, `tests/living-state.test.ts`

**Interfaces:**
- Consumes: `Drives.boundary`, `PersonaState.ngambekUntil`.
- Produces: `computeMood(input: { ...; ngambekEnabled: boolean })`; `applyOwnerSentiment` sets `boundary` up on cuek/rude and `ngambekUntil = now + ngambekDurationMs`; ngambek clears only when (a) `now > ngambekUntil` OR (b) owner sends a kind message AND `now - ngambekStart >= ngambekMinMs`.

- [ ] **Step 1: Write failing tests**
  - `mood.test.ts`: with `ngambekEnabled: true`, cue contains ngambek wording while active; a single kind message does NOT clear it before `ngambekMinMs`; it clears after.
  - `living-state.test.ts`: rude text raises `drives.boundary`; boundary decays over time.

- [ ] **Step 2: Run tests, expect FAIL** (flag currently hard-coded `false`).

- [ ] **Step 3: Implement** the above; default `ngambekEnabled` stays `false` (log-only) until owner calibrates, but the code path + tests exist for when it flips.

- [ ] **Step 4: Run tests, expect PASS** — `pnpm exec tsx --test tests/mood.test.ts tests/living-state.test.ts`.

- [ ] **Step 5: Commit** `feat: boundaries and consistent ngambek behind flag`

---

### Task 7: Initiative — proactive from drives

**Files:**
- Modify: `src/core/heartbeat.ts` (`runSocial` reads `LivingState` drives; replace `spontaneous` trigger)
- Modify: `src/core/living-state.ts` (`shouldInitiate(state, input): { initiate: boolean; kind: "greeting" | "share" | "company" }`)
- Test: `tests/heartbeat.test.ts`, `tests/living-state.test.ts`

**Interfaces:**
- Consumes: `wantCompany`, `wantToShare`, `activity`, existing rems (`quietHours`, `maxUnansweredProactive`).
- Produces: `shouldInitiate(state: PersonaState, input: { now: number; idleMs: number }): "greeting" | "share" | "company" | null`.

- [ ] **Step 1: Write failing tests**
  - `living-state.test.ts`: high `wantToShare` + activity just ended → `"share"`; high `wantCompany` + long silence → `"company"`; none → `null`.
  - `heartbeat.test.ts`: drive-driven initiate respects `quietHours` and `maxUnansweredProactive`; daily `greeting` still fires once per local date and never doubles with drive triggers.

- [ ] **Step 2: Run tests, expect FAIL** — `runSocial` still uses `spontaneousIdleHours`.

- [ ] **Step 3: Implement** `shouldInitiate`; rewrite `runSocial` to: check quiet hours + unanswered cap → greeting claim (unchanged) → else `shouldInitiate` and `wake` with the matching trigger. Remove `spontaneous` idle check; keep `WakeupEvent.triggerType` union valid (add `"share" | "company"` or map both to `"spontaneous"` — pick mapping to `"spontaneous"` to avoid schema churn).

- [ ] **Step 4: Run tests, expect PASS** — `pnpm exec tsx --test tests/heartbeat.test.ts tests/living-state.test.ts`.

- [ ] **Step 5: Commit** `feat: drive-driven proactive initiative`

---

## Self-Review

- **Spec coverage:** §6.1→T1; §6.2→T3+T4; §6.3→T3; §6.4 momen1→T5, momen2→T6, momen3→T7; §6.5→T2+T4; §6.6→T6; §10.1→T7; §10.2→T5; §10.3→T6; §10.4→T1; §10.5→all tests deterministic. No gap.
- **Type consistency:** `RepliesConfig` (T1) reused T5/T6; `PersonaState.activity/drives` (T3) reused T4/T5/T6/T7; `decideReply`/`shouldInitiate`/`renderStateCue` single definitions in `living-state.ts`.
- **Review Focus tests:** (1) T1 command-burst test; (2) T5 defer-then-reply; (3) T3 corrupt-json test; (4) T5 content-untouched assertion; (5) T7 rem test.
- **Proportion:** plan ≈ spec length; no bodies transcribed except test assertions.

## Deferred (not in this plan)

- Model reporting back acted drive / state delta (spec §6.5 optional) — add only if cue-only proves insufficient.
- Tuning drive constants beyond initial defaults (spec §8) — after ~1 week calibration log.
- Full `LivingState` table (vs `settings_json`) — only if the JSON slice grows unwieldy.