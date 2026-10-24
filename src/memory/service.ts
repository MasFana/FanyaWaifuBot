import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../core/clock.js";
import { type PersonaState, parsePersonaState } from "../core/persona-state.js";
import type { CommitmentInput, FactInput, InboundEvent, ToolCall } from "../core/types.js";

export type FactStatus = "active" | "replaced" | "deleted";
export type CommitmentStatus = "pending" | "completed" | "cancelled";

export interface Owner {
  id: string;
  displayName: string;
  timezone: string;
  createdAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  content: string | null;
  isProactive: boolean;
  toolCallId?: string;
  toolCalls?: readonly ToolCall[];
  createdAt: number;
}

export interface ImageContext {
  messageId: string;
  description: string;
  createdAt: number;
}

export interface Fact {
  id: string;
  userId: string;
  content: string;
  category: string;
  origin: FactInput["origin"];
  status: FactStatus;
  replacedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Commitment {
  id: string;
  userId: string;
  title: string;
  contextNotes: string;
  eventAt: number | null;
  remindAt: number | null;
  followUpAt: number | null;
  status: CommitmentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResults {
  messages: StoredMessage[];
  imageContexts: ImageContext[];
  facts: Fact[];
}

export interface ForgetCandidate {
  kind: "fact" | "commitment";
  id: string;
  content: string;
}

export type ForgetResult =
  | { outcome: "not_found" }
  | { outcome: "deleted"; candidate: ForgetCandidate }
  | { outcome: "ambiguous"; candidates: ForgetCandidate[] };

export interface OwnerExport {
  owner: Owner;
  facts: Fact[];
  commitments: Commitment[];
  messages: StoredMessage[];
}

export interface PromptState {
  lastUserMessageAt: number | null;
  summary: string | null;
}

export type DueCommitment = Commitment & { kind: "reminder" | "followup" };

export interface AppendMessageInput {
  channel: string;
  role: StoredMessage["role"];
  content: string | null;
  isProactive?: boolean;
  runId?: string;
  toolCallsJson?: string;
  toolCallId?: string;
}

export type AgentTrigger = "inbound" | "agenda_reminder" | "agenda_followup" | "spontaneous" | "greeting";

interface OwnerRow { id: string; display_name: string; timezone: string; created_at: number }
interface ClaimedOwnerRow extends OwnerRow { external_id: string }
interface ConversationRow { id: string }
interface SequenceRow { next_seq: number }
interface FactRow { id: string; user_id: string; content: string; category: string; origin: FactInput["origin"]; status: FactStatus; replaced_by: string | null; created_at: number; updated_at: number }
interface CommitmentRow { id: string; user_id: string; title: string; context_notes: string; event_at: number | null; remind_at: number | null; follow_up_at: number | null; status: CommitmentStatus; created_at: number; updated_at: number }
interface MessageRow { id: string; conversation_id: string; seq: number; role: StoredMessage["role"]; content: string | null; is_proactive: number; tool_calls_json: string | null; tool_call_id: string | null; created_at: number }
interface ImageContextRow { message_id: string; description: string; created_at: number }
const factColumns = "id, user_id, content, category, origin, status, replaced_by, created_at, updated_at";
const commitmentColumns = "id, user_id, title, context_notes, event_at, remind_at, follow_up_at, status, created_at, updated_at";
const messageColumns = "id, conversation_id, seq, role, content, is_proactive, tool_calls_json, tool_call_id, created_at";
const prefixedFactColumns = factColumns.split(", ").map((column) => `f.${column}`).join(", ");
const prefixedMessageColumns = messageColumns.split(", ").map((column) => `m.${column}`).join(", ");
/** Changed schedule timestamps match only inside this bounded correction window. */
const commitmentMatchWindowMs = 24 * 60 * 60_000;

export class MemoryService {
  constructor(private readonly database: Database.Database, private readonly clock: Clock) {}

  claimOwner(channel: string, externalId: string): Owner | undefined {
    return this.database.transaction(() => {
      const existing = this.resolveOwner(channel, externalId);
      if (existing) return existing;
      const claimed = this.database.prepare("SELECT 1 FROM identities LIMIT 1").get();
      if (claimed !== undefined) return undefined;
      const now = this.clock.now();
      const id = externalId;
      this.database.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, now);
      this.database.prepare("INSERT INTO identities (channel, external_id, user_id, created_at) VALUES (?, ?, ?, ?)").run(channel, externalId, id, now);
      return this.resolveOwner(channel, externalId);
    })();
  }

  /** Establish configured owner without migrating a prior first claim. */
  ensureOwner(channel: string, externalId: string): Owner {
    const existing = this.resolveOwner(channel, externalId);
    if (existing) return existing;
    return this.database.transaction(() => {
      const current = this.resolveOwner(channel, externalId);
      if (current) return current;
      const now = this.clock.now();
      this.database.prepare("INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").run(externalId, now);
      this.database.prepare("INSERT INTO identities (channel, external_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(channel, external_id) DO NOTHING").run(channel, externalId, externalId, now);
      const owner = this.resolveOwner(channel, externalId);
      if (!owner) throw new Error("Failed to establish owner identity");
      return owner;
    })();
  }

  resolveOwner(channel: string, externalId: string): Owner | undefined {
    const row = this.database.prepare("SELECT u.id, u.display_name, u.timezone, u.created_at FROM identities i JOIN users u ON u.id = i.user_id WHERE i.channel = ? AND i.external_id = ?").get(channel, externalId) as OwnerRow | undefined;
    return row === undefined ? undefined : toOwner(row);
  }

  resolveClaimedOwner(channel: string): { externalId: string; owner: Owner } | undefined {
    const row = this.database.prepare("SELECT i.external_id, u.id, u.display_name, u.timezone, u.created_at FROM identities i JOIN users u ON u.id = i.user_id WHERE i.channel = ? LIMIT 1").get(channel) as ClaimedOwnerRow | undefined;
    return row === undefined ? undefined : { externalId: row.external_id, owner: toOwner(row) };
  }

  recordInbound(channel: string, event: InboundEvent): boolean {
    return this.database.transaction(() => this.database.prepare("INSERT INTO inbound_events (channel, external_message_id, received_at) VALUES (?, ?, ?) ON CONFLICT(channel, external_message_id) DO NOTHING").run(channel, event.id, event.receivedAt).changes === 1)();
  }

  appendMessage(userId: string, input: AppendMessageInput): StoredMessage {
    return this.database.transaction(() => this.appendMessageUnsafe(userId, input))();
  }

  saveImageContext(userId: string, messageId: string, description: string): ImageContext | undefined {
    if (description.length === 0 || description.length > 600) throw new RangeError("Image context description must be 1-600 characters");
    return this.database.transaction(() => {
      const source = this.database.prepare("SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ? AND c.user_id = ?").get(messageId, userId) as { id: string } | undefined;
      if (source === undefined) return undefined;
      const now = this.clock.now();
      const id = randomUUID();
      const inserted = this.database.prepare("INSERT INTO image_contexts (id, message_id, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING").run(id, messageId, description, now);
      if (inserted.changes === 1) {
        this.database.prepare("INSERT INTO messages_fts (content, conversation_id, message_id, role, created_at) SELECT ?, m.conversation_id, m.id, m.role, ? FROM messages m WHERE m.id = ?").run(description, now, messageId);
      }
      const row = this.database.prepare("SELECT message_id, description, created_at FROM image_contexts WHERE message_id = ?").get(messageId) as ImageContextRow;
      return toImageContext(row);
    })();
  }

  getImageContexts(userId: string, messageIds: readonly string[]): ReadonlyMap<string, ImageContext> {
    if (messageIds.length === 0) return new Map();
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`SELECT i.message_id, i.description, i.created_at FROM image_contexts i JOIN messages m ON m.id = i.message_id JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND i.message_id IN (${placeholders})`).all(userId, ...messageIds) as ImageContextRow[];
    return new Map(rows.map((row) => [row.message_id, toImageContext(row)]));
  }

  createAgentRun(userId: string, triggerType: AgentTrigger, model: string): string {
    const conversation = this.getOrCreateConversation(userId, "telegram");
    const id = randomUUID();
    this.database.prepare("INSERT INTO agent_runs (id, conversation_id, trigger_type, model, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(id, conversation.id, triggerType, model, this.clock.now());
    return id;
  }

  finishAgentRun(runId: string, status: "completed" | "failed" | "skipped", error?: unknown): void {
    this.database.prepare("UPDATE agent_runs SET status = ?, finished_at = ?, error_json = ? WHERE id = ?").run(status, this.clock.now(), error === undefined ? null : JSON.stringify(error), runId);
  }

  recordToolEvent(runId: string, toolCallId: string, toolName: string, arguments_: Record<string, unknown>, result: unknown, status: "ok" | "error", durationMs: number): void {
    this.database.prepare("INSERT INTO tool_events (id, run_id, tool_call_id, tool_name, arguments_json, result_json, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), runId, toolCallId, toolName, JSON.stringify(arguments_), JSON.stringify(result), status, durationMs, this.clock.now());
  }

  recordToolResult(userId: string, runId: string, call: ToolCall, result: unknown, status: "ok" | "error", durationMs: number): StoredMessage {
    return this.database.transaction(() => {
      this.database.prepare("INSERT INTO tool_events (id, run_id, tool_call_id, tool_name, arguments_json, result_json, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), runId, call.id, call.name, JSON.stringify(call.arguments), JSON.stringify(result), status, durationMs, this.clock.now());
      return this.appendMessageUnsafe(userId, { channel: "telegram", role: "tool", content: JSON.stringify(result), runId, toolCallId: call.id });
    })();
  }

  upsertFact(userId: string, input: FactInput): Fact {
    return this.database.transaction(() => {
      const now = this.clock.now();
      const id = randomUUID();
      const key = factKey(input.category, input.content);
      const active = this.database.prepare(`SELECT ${factColumns} FROM facts WHERE user_id = ? AND category = ? AND status = 'active'`).all(userId, input.category) as FactRow[];
      for (const fact of active.filter((candidate) => factKey(candidate.category, candidate.content) === key)) {
        this.database.prepare("UPDATE facts SET status = 'replaced', replaced_by = ?, updated_at = ? WHERE id = ?").run(id, now, fact.id);
        this.database.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(fact.id);
      }
      this.database.prepare("INSERT INTO facts (id, user_id, content, category, origin, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(id, userId, input.content, input.category, input.origin, now, now);
      this.database.prepare("INSERT INTO facts_fts (content, category, fact_id) VALUES (?, ?, ?)").run(input.content, input.category, id);
      return { id, userId, content: input.content, category: input.category, origin: input.origin, status: "active" as const, replacedBy: null, createdAt: now, updatedAt: now };
    })();
  }

  getFact(id: string): Fact | undefined {
    const row = this.database.prepare(`SELECT ${factColumns} FROM facts WHERE id = ?`).get(id) as FactRow | undefined;
    return row === undefined ? undefined : toFact(row);
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.database.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row === undefined ? undefined : toMessage(row);
  }

  listActiveFacts(userId: string): Fact[] {
    return (this.database.prepare(`SELECT ${factColumns} FROM facts WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC`).all(userId) as FactRow[]).map(toFact);
  }

  upsertCommitment(userId: string, input: CommitmentInput): Commitment {
    if (input.eventAt <= this.clock.now()) throw new RangeError("Commitment event must be in the future");
    return this.database.transaction(() => {
      const now = this.clock.now();
      const existing = this.database.prepare(`SELECT ${commitmentColumns} FROM commitments WHERE user_id = ? AND status = 'pending' AND lower(trim(title)) = ? AND ABS(event_at - ?) <= ? ORDER BY ABS(event_at - ?) LIMIT 1`).get(userId, normalize(input.title), input.eventAt, commitmentMatchWindowMs, input.eventAt) as CommitmentRow | undefined;
      const remindAt = input.remindAt ?? input.eventAt - 75 * 60_000;
      const followUpAt = input.followUpAt ?? input.eventAt + 150 * 60_000;
      if (existing) {
        this.database.prepare("UPDATE commitments SET context_notes = ?, event_at = ?, remind_at = ?, follow_up_at = ?, updated_at = ? WHERE id = ?").run(input.contextNotes ?? "", input.eventAt, remindAt, followUpAt, now, existing.id);
        return { ...toCommitment(existing), contextNotes: input.contextNotes ?? "", eventAt: input.eventAt, remindAt, followUpAt, updatedAt: now };
      }
      const id = randomUUID();
      this.database.prepare("INSERT INTO commitments (id, user_id, title, context_notes, event_at, remind_at, follow_up_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, input.title, input.contextNotes ?? "", input.eventAt, remindAt, followUpAt, now, now);
      return { id, userId, title: input.title, contextNotes: input.contextNotes ?? "", eventAt: input.eventAt, remindAt, followUpAt, status: "pending" as const, createdAt: now, updatedAt: now };
    })();
  }

  listPendingCommitments(userId: string): Commitment[] {
    return (this.database.prepare(`SELECT ${commitmentColumns} FROM commitments WHERE user_id = ? AND status = 'pending' ORDER BY event_at ASC`).all(userId) as CommitmentRow[]).map(toCommitment);
  }

  claimDueCommitments(now: number, userId?: string): DueCommitment[] {
    return this.database.transaction(() => {
      const claims: DueCommitment[] = [];
      for (const [kind, dueColumn, claimedColumn] of [["reminder", "remind_at", "reminded_at"], ["followup", "follow_up_at", "followed_up_at"]] as const) {
        const userClause = userId === undefined ? "" : " AND user_id = ?";
        const due = this.database.prepare(`SELECT ${commitmentColumns} FROM commitments WHERE status = 'pending'${userClause} AND ${dueColumn} IS NOT NULL AND ${dueColumn} <= ? AND ${claimedColumn} IS NULL ORDER BY ${dueColumn} ASC`).all(...(userId === undefined ? [now] : [userId, now])) as CommitmentRow[];
        const claim = this.database.prepare(`UPDATE commitments SET ${claimedColumn} = ?, updated_at = ? WHERE id = ? AND ${claimedColumn} IS NULL`);
        for (const row of due) {
          if (claim.run(now, now, row.id).changes === 1) claims.push({ ...toCommitment(row), kind });
        }
      }
      return claims;
    })();
  }

  revertCommitmentClaim(id: string, kind: DueCommitment["kind"]): void {
    const column = kind === "reminder" ? "reminded_at" : "followed_up_at";
    this.database.prepare(`UPDATE commitments SET ${column} = NULL, updated_at = ? WHERE id = ?`).run(this.clock.now(), id);
  }

  claimProactiveEvent(userId: string, kind: "morning" | "night", localDate: string): boolean {
    return this.database.prepare("INSERT INTO proactive_events (user_id, kind, local_date) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(userId, kind, localDate).changes === 1;
  }

  revertProactiveEvent(userId: string, kind: "morning" | "night", localDate: string): void {
    this.database.prepare("DELETE FROM proactive_events WHERE user_id = ? AND kind = ? AND local_date = ?").run(userId, kind, localDate);
  }

  recordProactiveSend(userId: string, options: { countUnanswered?: boolean } = {}): void {
    if (options.countUnanswered === false) {
      this.database.prepare("UPDATE users SET last_proactive_at = ? WHERE id = ?").run(this.clock.now(), userId);
      return;
    }
    this.database.prepare("UPDATE users SET last_proactive_at = ?, unanswered_proactive_count = unanswered_proactive_count + 1 WHERE id = ?").run(this.clock.now(), userId);
  }

  getProactiveState(userId: string): { lastUserMessageAt: number | null; lastProactiveAt: number | null; unansweredCount: number; quietHours: { start: string; end: string } } {
    const row = this.database.prepare("SELECT last_user_message_at, last_proactive_at, unanswered_proactive_count, quiet_hours_start, quiet_hours_end FROM users WHERE id = ?").get(userId) as { last_user_message_at: number | null; last_proactive_at: number | null; unanswered_proactive_count: number; quiet_hours_start: string; quiet_hours_end: string } | undefined;
    return { lastUserMessageAt: row?.last_user_message_at ?? null, lastProactiveAt: row?.last_proactive_at ?? null, unansweredCount: row?.unanswered_proactive_count ?? 0, quietHours: { start: row?.quiet_hours_start ?? "23:30", end: row?.quiet_hours_end ?? "06:30" } };
  }

  setQuietHours(userId: string, start: string, end: string): void {
    this.database.prepare("UPDATE users SET quiet_hours_start = ?, quiet_hours_end = ? WHERE id = ?").run(start, end, userId);
  }

  setUnansweredProactiveCount(userId: string, count: number): void {
    this.database.prepare("UPDATE users SET unanswered_proactive_count = ? WHERE id = ?").run(count, userId);
  }

  getUnansweredProactiveCount(userId: string): number {
    const row = this.database.prepare("SELECT unanswered_proactive_count FROM users WHERE id = ?").get(userId) as { unanswered_proactive_count: number } | undefined;
    return row?.unanswered_proactive_count ?? 0;
  }

  resetUnansweredProactiveCount(userId: string): void {
    this.setUnansweredProactiveCount(userId, 0);
  }

  recordOwnerActivity(userId: string): void {
    this.database.prepare("UPDATE users SET last_user_message_at = ? WHERE id = ?").run(this.clock.now(), userId);
  }

  search(userId: string, query: string): SearchResults {
    const messages = this.database.prepare(`SELECT ${prefixedMessageColumns} FROM messages_fts f JOIN messages m ON m.id = f.message_id JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ? AND c.user_id = ? ORDER BY bm25(messages_fts) LIMIT 10`).all(ftsQuery(query), userId) as MessageRow[];
    const imageContexts = this.database.prepare("SELECT i.message_id, i.description, i.created_at FROM messages_fts f JOIN image_contexts i ON i.message_id = f.message_id JOIN messages m ON m.id = i.message_id JOIN conversations c ON c.id = m.conversation_id WHERE messages_fts MATCH ? AND c.user_id = ? ORDER BY bm25(messages_fts) LIMIT 10").all(ftsQuery(query), userId) as ImageContextRow[];
    const facts = this.database.prepare(`SELECT ${prefixedFactColumns} FROM facts_fts x JOIN facts f ON f.id = x.fact_id WHERE facts_fts MATCH ? AND f.user_id = ? AND f.status = 'active' ORDER BY bm25(facts_fts) LIMIT 10`).all(ftsQuery(query), userId) as FactRow[];
    return { messages: messages.map(toMessage), imageContexts: imageContexts.map(toImageContext), facts: facts.map(toFact) };
  }

  forget(userId: string, topic: string): ForgetResult {
    return this.database.transaction((): ForgetResult => {
      const pattern = `%${normalize(topic)}%`;
      const facts = this.database.prepare(`SELECT ${factColumns} FROM facts WHERE user_id = ? AND status = 'active' AND lower(content) LIKE ? ORDER BY updated_at DESC`).all(userId, pattern) as FactRow[];
      const commitments = this.database.prepare(`SELECT ${commitmentColumns} FROM commitments WHERE user_id = ? AND status = 'pending' AND lower(title) LIKE ? ORDER BY event_at ASC`).all(userId, pattern) as CommitmentRow[];
      const candidates: ForgetCandidate[] = [
        ...facts.map((fact) => ({ kind: "fact" as const, id: fact.id, content: fact.content })),
        ...commitments.map((commitment) => ({ kind: "commitment" as const, id: commitment.id, content: commitment.title })),
      ];
      if (candidates.length === 0) return { outcome: "not_found" };
      if (candidates.length > 1) return { outcome: "ambiguous", candidates };
      const candidate = candidates[0];
      if (!candidate) return { outcome: "not_found" };
      if (candidate.kind === "fact") {
        this.database.prepare("UPDATE facts SET status = 'deleted', updated_at = ? WHERE id = ?").run(this.clock.now(), candidate.id);
        this.database.prepare("DELETE FROM facts_fts WHERE fact_id = ?").run(candidate.id);
        return { outcome: "deleted", candidate };
      }
      this.database.prepare("UPDATE commitments SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.clock.now(), candidate.id);
      return { outcome: "deleted", candidate };
    })();
  }

  exportOwner(userId: string): OwnerExport {
    return this.database.transaction(() => {
      const owner = this.database.prepare("SELECT id, display_name, timezone, created_at FROM users WHERE id = ?").get(userId) as OwnerRow | undefined;
      if (!owner) throw new RangeError("Owner does not exist");
      const commitments = (this.database.prepare(`SELECT ${commitmentColumns} FROM commitments WHERE user_id = ? ORDER BY event_at ASC`).all(userId) as CommitmentRow[]).map(toCommitment);
      const messages = (this.database.prepare(`SELECT ${prefixedMessageColumns} FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? ORDER BY m.created_at ASC, m.seq ASC`).all(userId) as MessageRow[]).map(toMessage);
      return { owner: toOwner(owner), facts: this.listActiveFacts(userId), commitments, messages };
    })();
  }

  getPromptState(userId: string): PromptState {
    const owner = this.database.prepare("SELECT last_user_message_at FROM users WHERE id = ?").get(userId) as { last_user_message_at: number | null } | undefined;
    const conversation = this.database.prepare("SELECT summary FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1").get(userId) as { summary: string | null } | undefined;
    return { lastUserMessageAt: owner?.last_user_message_at ?? null, summary: conversation?.summary ?? null };
  }

  latestOwnerMessage(userId: string): StoredMessage | undefined {
    const row = this.database.prepare(`SELECT ${prefixedMessageColumns} FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ? AND m.role = 'user' ORDER BY m.created_at DESC, m.seq DESC LIMIT 1`).get(userId) as MessageRow | undefined;
    return row === undefined ? undefined : toMessage(row);
  }

  setMood(userId: string, mood: string): void {
    this.database.prepare("UPDATE users SET current_mood = ?, mood_updated_at = ? WHERE id = ?").run(mood, this.clock.now(), userId);
  }

  getPersonaState(userId: string): PersonaState {
    const row = this.database.prepare("SELECT settings_json FROM users WHERE id = ?").get(userId) as { settings_json: string | null } | undefined;
    return parsePersonaState(row?.settings_json ?? null);
  }

  setPersonaState(userId: string, state: PersonaState): void {
    this.database.prepare("UPDATE users SET settings_json = ? WHERE id = ?").run(JSON.stringify(state), userId);
  }

  private getOrCreateConversation(userId: string, channel: string): ConversationRow {
    const existing = this.database.prepare("SELECT id FROM conversations WHERE user_id = ? AND channel = ? ORDER BY updated_at DESC LIMIT 1").get(userId, channel) as ConversationRow | undefined;
    if (existing) return existing;
    const id = randomUUID();
    const now = this.clock.now();
    this.database.prepare("INSERT INTO conversations (id, user_id, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, userId, channel, now, now);
    return { id };
  }

  private appendMessageUnsafe(userId: string, input: AppendMessageInput): StoredMessage {
    const conversation = this.getOrCreateConversation(userId, input.channel);
    const now = this.clock.now();
    const seq = (this.database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE conversation_id = ?").get(conversation.id) as SequenceRow).next_seq;
    const id = randomUUID();
    this.database.prepare("INSERT INTO messages (id, conversation_id, run_id, seq, role, is_proactive, content, tool_calls_json, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, conversation.id, input.runId ?? null, seq, input.role, input.isProactive ? 1 : 0, input.content, input.toolCallsJson ?? null, input.toolCallId ?? null, now);
    if (input.content !== null) this.database.prepare("INSERT INTO messages_fts (content, conversation_id, message_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run(input.content, conversation.id, id, input.role, now);
    this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversation.id);
    return { id, conversationId: conversation.id, seq, role: input.role, content: input.content, isProactive: input.isProactive ?? false, ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }), createdAt: now };
  }
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
function factKey(category: string, content: string): string {
  const prefix = normalize(content.split(":", 1)[0] ?? content);
  if (normalize(category) !== "preferensi") return prefix;
  if (/^(tidak suka|benci)\b/.test(prefix)) return "negative-preference";
  if (/^(suka|senang|gemar)\b/.test(prefix)) return "positive-preference";
  if (/^(favorit|kesukaan)\b/.test(prefix)) return "favorite-preference";
  return prefix;
}
function ftsQuery(query: string): string { return normalize(query).split(" ").filter(Boolean).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND "); }
function toOwner(row: OwnerRow): Owner { return { id: row.id, displayName: row.display_name, timezone: row.timezone, createdAt: row.created_at }; }
function toFact(row: FactRow): Fact { return { id: row.id, userId: row.user_id, content: row.content, category: row.category, origin: row.origin, status: row.status, replacedBy: row.replaced_by, createdAt: row.created_at, updatedAt: row.updated_at }; }
function toCommitment(row: CommitmentRow): Commitment { return { id: row.id, userId: row.user_id, title: row.title, contextNotes: row.context_notes, eventAt: row.event_at, remindAt: row.remind_at, followUpAt: row.follow_up_at, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }; }
function toMessage(row: MessageRow): StoredMessage {
  const toolCalls = row.tool_calls_json === null ? undefined : parseToolCalls(row.tool_calls_json);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    isProactive: row.is_proactive === 1,
    ...(row.tool_call_id === null ? {} : { toolCallId: row.tool_call_id }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    createdAt: row.created_at,
  };
}

function toImageContext(row: ImageContextRow): ImageContext {
  return { messageId: row.message_id, description: row.description, createdAt: row.created_at };
}

function parseToolCalls(value: string): readonly ToolCall[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isToolCall)) return undefined;
    return parsed;
  } catch { return undefined; }
}

function isToolCall(value: unknown): value is ToolCall {
  return typeof value === "object" && value !== null
    && typeof (value as Record<string, unknown>)["id"] === "string"
    && typeof (value as Record<string, unknown>)["name"] === "string"
    && isRecord((value as Record<string, unknown>)["arguments"]);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
