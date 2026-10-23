# Fanya v2 Anti-Bot Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Telegram companion bot (Fanya) stop sounding formulaic by de-anchoring persona examples and adding deterministic, code-computed mood + anti-repetition state.

**Architecture:** Keep `harness/persona.md` static (voice only, no quotable example strings). Add mutable state — affection, ngambek timer, recent openings/endings/emojis — persisted as JSON in the existing `users.settings_json` column behind `MemoryService.getPersonaState`/`setPersonaState`. A pure `computeMood()` derives a per-turn mood cue; `ContextBuilder.build` renders it plus a "do not repeat" line into the existing dynamic block. No new dependency, no schema migration.

**Tech Stack:** TypeScript (ESM, Node 24), better-sqlite3, node:test, zod.

**Spec:** `docs/superpowers/specs/2026-10-23-fanya-v2-anti-bot-design.md`

## Global Constraints

- No new npm dependency.
- ESM only: relative imports end in `.js` (e.g. `import { computeMood } from "./mood.js"`).
- Tests use `node:test` + `node:assert/strict`; DB tests use `openDatabase(":memory:")` + `migrate(database, clock)` + `FrozenClock`.
- Do not change the 6 known pre-existing test failures: `tests/acceptance.test.ts:40,76,96`, `tests/telegram-auth.test.ts:95`, `tests/telegram-commands.test.ts:50,99`.
- `pnpm typecheck` must stay clean after every task.
- Never edit `data/fanya.db` while the bot runs; tests never touch it.

## Review Focus

Uncovered inputs most likely to bite, each pinned by a test in the owning task:
1. Corrupt/absent `settings_json` → `parsePersonaState` returns defaults, never throws (Task 2).
2. System/command turns (`[SYSTEM COMMAND: ...]`, `[SYSTEM WAKEUP]`) must not feed sentiment or affection (Task 3).
3. First-ever message: `lastUserMessageAt === null` → mood cue must not be `NaN`/`Infinity` (Task 3).
4. Reply text with no emoji and no ending punctuation → `extractTraits` must not throw (Task 2).
5. Ngambek disabled by flag → no cold/wrong cue leaks into the prompt (Task 4).

---

### Task 1: De-anchor persona.md and add shape/ending/task rules

**Files:**
- Modify: `harness/persona.md`
- Create: `harness/tone-examples.md`
- Test: `tests/persona.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `harness/persona.md` free of quotable example utterances, plus rule text containing the literal markers `Bentuk balon` and `jangan pakai bullet` (later tasks' tests do not depend on these; only this task's test does).

- [ ] **Step 1: Write the failing test** — `tests/persona.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("persona drops quotable example utterances but keeps shape rules", async () => {
  const persona = await readFile("harness/persona.md", "utf8");
  for (const artifact of ["pagiiiii", "asdfghjkl", "bikin aku salting tiba-tiba", "jantung aku jedag jedug"]) {
    assert.equal(persona.includes(artifact), false, `leaked example: ${artifact}`);
  }
  assert.match(persona, /Bentuk balon/u);
  assert.match(persona, /jangan pakai bullet/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx --test tests/persona.test.ts`
Expected: FAIL — `leaked example: pagiiiii`.

- [ ] **Step 3: Rewrite `harness/persona.md`**

Remove every verbatim first-person example utterance: section 3 "Contoh 1/2" blocks, section 4 "Situasi 1/2/3" dialogues, section 5 examples on lines 108–117, the `pagiiiii` greeting example on line 119, and the `asdfghjkl` / `(⁄ ⁄•⁄ω⁄•⁄ ⁄)` reaction string on line 14. Replace each with a bracketed **descriptor** of tone (e.g. `[sapaan pagi: 1–4 kata, groggy, lowercase, boleh trail-off; JANGAN salin kata]`). Keep the vocabulary and `HARAM emoji` lists (line 42) — those are rules, not examples. Add two rule blocks:

```markdown
## Bentuk balon
- ~30% balasan cukup 1 balon pendek; ~10% cukup 1 kata/emoji/`...`; maksimum 3 balon.
- Akhiran netral adalah modal. Akhiran manis hanya ~20% pesan. Kadang berhenti di tengah pikiran, tanpa emoji.
```

```markdown
## Turn task
- Saat membantu/menjawab teknis (mis. gagal unduh link), tetap pakai suara Fanya. **jangan pakai bullet** (`-`/`•`) atau panah (`->`) di turn biasa.
```

- [ ] **Step 4: Create `harness/tone-examples.md`** — doc-only reference (NOT loaded at runtime by `ContextBuilder.load`). Hold the old dialogues here labeled "bentuk, bukan teks".

- [ ] **Step 5: Run test to verify it passes**

Run: `tsx --test tests/persona.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add harness/persona.md harness/tone-examples.md tests/persona.test.ts
git commit -m "refactor: de-anchor persona examples, add shape rules"
```

---

### Task 2: Persona state store, trait extraction, anti-repetition guard

**Files:**
- Create: `src/core/persona-state.ts`
- Modify: `src/memory/service.ts` (add two methods near `setMood`, ~line 343)
- Modify: `src/core/context.ts` (add dynamic line, ~line 37-44)
- Modify: `src/core/agent.ts` (record traits after delivery, in `loop` at the `content` delivery branch ~line 77-80)
- Test: `tests/persona-state.test.ts`, `tests/agent.test.ts`, `tests/memory.test.ts`

**Interfaces:**
- Consumes: `MemoryService` existing `settings_json` column.
- Produces:
  - `interface PersonaState { affection: number; ngambekUntil: number | null; recentOpenings: string[]; recentEndings: string[]; recentEmojis: string[] }`
  - `const defaultPersonaState: PersonaState` (affection 0.7, others empty/null)
  - `parsePersonaState(json: string | null): PersonaState`
  - `extractTraits(text: string): { opening: string; ending: string; emojis: string[] }`
  - `mergeTraits(state: PersonaState, traits: { opening: string; ending: string; emojis: string[] }, cap?: number): PersonaState`
  - `MemoryService.getPersonaState(userId: string): PersonaState`
  - `MemoryService.setPersonaState(userId: string, state: PersonaState): void`

- [ ] **Step 1: Write the failing test** — `tests/persona-state.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState, extractTraits, mergeTraits, parsePersonaState } from "../src/core/persona-state.js";

test("parsePersonaState defaults on corrupt or absent json", () => {
  assert.deepEqual(parsePersonaState(null), defaultPersonaState);
  assert.deepEqual(parsePersonaState("{not json"), defaultPersonaState);
  assert.deepEqual(parsePersonaState('{"affection":"x"}'), defaultPersonaState);
});

test("extractTraits is safe on plain text", () => {
  assert.deepEqual(extractTraits("iyaa"), { opening: "iyaa", ending: "iyaa", emojis: [] });
  assert.deepEqual(extractTraits(""), { opening: "", ending: "", emojis: [] });
});

test("mergeTraits caps recent lists and keeps newest last", () => {
  let state = defaultPersonaState;
  for (const end of ["a", "b", "c", "d", "e", "f"]) {
    state = mergeTraits(state, { opening: end, ending: end, emojis: [] });
  }
  assert.deepEqual(state.recentEndings, ["b", "c", "d", "e", "f"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx --test tests/persona-state.test.ts`
Expected: FAIL — cannot find module `../src/core/persona-state.js`.

- [ ] **Step 3: Implement `src/core/persona-state.ts`**

`parsePersonaState` JSON-parses and validates shape with `zod`; on any failure returns `defaultPersonaState`. `extractTraits`: `opening` = first 3 whitespace-split words of the text, lowercased, leading/trailing punctuation stripped; `ending` = last word likewise; `emojis` = `text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? []`. `mergeTraits` appends and trims to `cap` (default 5).

- [ ] **Step 4: Add `MemoryService` methods**

```ts
getPersonaState(userId: string): PersonaState {
  const row = this.database.prepare("SELECT settings_json FROM users WHERE id = ?").get(userId) as { settings_json: string | null } | undefined;
  return parsePersonaState(row?.settings_json ?? null);
}
setPersonaState(userId: string, state: PersonaState): void {
  this.database.prepare("UPDATE users SET settings_json = ? WHERE id = ?").run(JSON.stringify(state), userId);
}
```

- [ ] **Step 5: Render anti-repeat line in `ContextBuilder.build`**

After reading state, compute `const personaState = this.memory.getPersonaState(input.userId);` and append one element to the `dynamic` array:

```ts
`Hindari mengulang: ${personaState.recentEndings.length === 0 ? "belum ada" : personaState.recentEndings.join(", ")}; emoji terpakai: ${personaState.recentEmojis.join(", ") || "belum ada"}`,
```

- [ ] **Step 6: Record traits after delivery in `Agent.loop`**

In the branch where `response.toolCalls.length === 0` and `response.content` is truthy, before returning `status: "completed"`:

```ts
const current = this.memory.getPersonaState(userId);
this.memory.setPersonaState(userId, mergeTraits(current, extractTraits(response.content)));
```

- [ ] **Step 7: Add tests** — `tests/agent.test.ts`: after an inbound whose reply ends `"halo 🤍"`, assert `memory.getPersonaState(owner.id).recentEndings` includes `"🤍"` and `recentEmojis` includes `"🤍"`. `tests/memory.test.ts`: round-trip `setPersonaState`/`getPersonaState`.

- [ ] **Step 8: Run tests**

Run: `tsx --test tests/persona-state.test.ts tests/agent.test.ts tests/memory.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/persona-state.ts src/memory/service.ts src/core/context.ts src/core/agent.ts tests/persona-state.test.ts tests/agent.test.ts tests/memory.test.ts
git commit -m "feat: persona state store and anti-repetition guard"
```

---

### Task 3: Deterministic mood engine

**Files:**
- Create: `src/core/mood.ts`
- Modify: `src/core/context.ts` (replace the `Mood terakhir` line, ~line 40)
- Modify: `src/core/agent.ts` (apply owner sentiment on inbound, in `runInbound` ~line 24)
- Modify: `src/memory/service.ts` (drop `mood` from `PromptState` + `getPromptState`, ~line 76-80, 332-336)
- Modify: `src/memory/writer.ts` (drop `mood` from extraction schema ~line 8 and the `setMood` call ~line 43)
- Test: `tests/mood.test.ts`; update `tests/writer.test.ts`, `tests/agent.test.ts`

**Interfaces:**
- Consumes: `PersonaState` (Task 2), `getPersonaState`/`setPersonaState` (Task 2).
- Produces:
  - `type Energy = "rendah" | "sedang" | "hangat"`
  - `interface MoodState { energy: Energy; missYou: boolean; ngambek: boolean; affection: number; cue: string }`
  - `computeMood(input: { now: number; timeZone: string; lastUserMessageAt: number | null; state: PersonaState }): MoodState`
  - `applyOwnerSentiment(state: PersonaState, text: string, now: number): PersonaState`

- [ ] **Step 1: Write the failing test** — `tests/mood.test.ts`

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPersonaState } from "../src/core/persona-state.js";
import { applyOwnerSentiment, computeMood } from "../src/core/mood.js";

const tz = "Asia/Jakarta";

test("energy follows local hour", () => {
  const night = computeMood({ now: Date.UTC(2026, 9, 23, 18, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(night.energy, "rendah");
});

test("first-ever message does not produce NaN", () => {
  const mood = computeMood({ now: Date.UTC(2026, 9, 23, 5, 0), timeZone: tz, lastUserMessageAt: null, state: defaultPersonaState });
  assert.equal(mood.missYou, false);
  assert.doesNotMatch(mood.cue, /NaN|Infinity/u);
});

test("long gap sets missYou", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: now - 9 * 3_600_000, state: defaultPersonaState });
  assert.equal(mood.missYou, true);
});

test("system turns are ignored, rude text lowers affection", () => {
  const start = defaultPersonaState;
  assert.deepEqual(applyOwnerSentiment(start, "[SYSTEM COMMAND: x]", 0), start);
  const rude = applyOwnerSentiment(start, "ntahlah males", 0);
  assert.ok(rude.affection < start.affection);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx --test tests/mood.test.ts`
Expected: FAIL — cannot find module `../src/core/mood.js`.

- [ ] **Step 3: Implement `src/core/mood.ts`**

`computeMood`: local hour via `Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hourCycle: "h23" })`; `energy` = hour < 7 → `"rendah"`, hour < 21 → `"sedang"`, else `"rendah"` (with evening 17–21 `"hangat"` — pick a concrete mapping and keep it in code). `missYou` = `lastUserMessageAt !== null && now - lastUserMessageAt > 8 * 3_600_000`. `ngambek` = `state.ngambekUntil !== null && now < state.ngambekUntil`. `cue` = a natural Indonesian sentence combining energy + missYou + affection band, e.g. `` `malam, ngantuk; ${missYou ? "kangen (kamu lama ga nyapa)" : "biasa aja"}; afeksi ${affection}` ``. `applyOwnerSentiment`: return `state` unchanged if `text.trimStart().startsWith("[SYSTEM")`; else nudge `affection` by `-0.1` when the normalized text matches a small rude/cuek list (`ntahlah`, `males`, `diem aja`, `gpp`, `terserah`) clamped to `[0,1]`; other text nudges `+0.05`.

- [ ] **Step 4: Wire into `ContextBuilder.build`**

Replace the `Mood terakhir: ...` element with `` `Suasana hati sekarang: ${mood.cue}` `` where `const mood = computeMood({ now, timeZone: exported.owner.timezone, lastUserMessageAt: state.lastUserMessageAt, state: personaState });`.

- [ ] **Step 5: Wire into `Agent.runInbound`**

Before `this.run(...)`: 

```ts
if (event.text.trim().length > 0 && !event.text.trimStart().startsWith("[SYSTEM")) {
  const state = this.memory.getPersonaState(event.userId);
  this.memory.setPersonaState(event.userId, applyOwnerSentiment(state, event.text, this.clock.now()));
}
```

- [ ] **Step 6: Remove the legacy LLM mood**

In `src/memory/writer.ts` delete `mood` from `extractionSchema` and the `if (parsed.data.mood !== undefined) this.memory.setMood(...)` line. In `src/memory/service.ts` remove `mood` from the `PromptState` interface and from `getPromptState`'s return (leave the `current_mood` and `setMood` DB artifacts in place; they become unused).

- [ ] **Step 7: Update affected tests**

`tests/writer.test.ts`: remove `mood: "bersemangat"` / `mood: "tenang"` from fixtures and drop all three `getPromptState(...).mood` assertions (lines 46, 64, 82); line 64's assertion (`=== null`) is also removed since the field no longer exists. `tests/agent.test.ts` (test starting line 172): replace the `current_mood = 'capek'` setup and the `capek` match with a `setPersonaState` seed and a match on the new `Suasana hati sekarang:` cue.

- [ ] **Step 8: Run tests**

Run: `tsx --test tests/mood.test.ts tests/writer.test.ts tests/agent.test.ts tests/memory.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/mood.ts src/core/context.ts src/core/agent.ts src/memory/service.ts src/memory/writer.ts tests/mood.test.ts tests/writer.test.ts tests/agent.test.ts
git commit -m "feat: deterministic mood engine, drop LLM mood"
```

---

### Task 4: Ngambek behind a log-only flag

**Files:**
- Modify: `src/core/mood.ts`
- Test: `tests/mood.test.ts`

**Interfaces:**
- Consumes: `computeMood` (Task 3).
- Produces: unchanged `MoodState` shape; when `ngambekInfluenceEnabled` is `false`, `MoodState.ngambek` is forced `false` and `MoodState.cue` carries no ngambek wording, while the raw decision is emitted via `console.warn("[mood] ngambek decision", { userId?, now })`.

- [ ] **Step 1: Write the failing test** — append to `tests/mood.test.ts`

```ts
test("ngambek influence is off while flag disabled", () => {
  const now = Date.UTC(2026, 9, 23, 5, 0);
  const state = { ...defaultPersonaState, ngambekUntil: now + 3_600_000 };
  const mood = computeMood({ now, timeZone: tz, lastUserMessageAt: now - 1_000, state });
  assert.equal(mood.ngambek, false);
  assert.doesNotMatch(mood.cue, /ngambek|dingin|cuek/u);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tsx --test tests/mood.test.ts`
Expected: FAIL — `mood.ngambek` is `true`.

- [ ] **Step 3: Implement the flag**

Add `const ngambekInfluenceEnabled = false;` in `src/core/mood.ts`. Compute the raw `ngambek` decision; when the flag is off, set `ngambek: false` in the returned `MoodState`, omit ngambek wording from `cue`, and emit the raw decision with `console.warn` (`ponytail:` remove console + flip flag once calibrated).

- [ ] **Step 4: Run test to verify it passes**

Run: `tsx --test tests/mood.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/mood.ts tests/mood.test.ts
git commit -m "feat: ngambek log-only behind disabled flag"
```

---

## Out of Scope (deferred, per spec §7)

- **G7** model-driven timing/burst cadence (`telegram.ts:340-357`).
- **G8** full DB-backed persona-state engine beyond the `settings_json` slice.
- Enabling ngambek influence (Task 4 flag) — after a ~1 week calibration log.