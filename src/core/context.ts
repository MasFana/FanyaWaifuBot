import type { Clock } from "./clock.js";
import { computeMood } from "./mood.js";
import { renderStateCue, tickLivingState } from "./living-state.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InboundImage, LLMMessage } from "./types.js";
import type { MemoryService } from "../memory/service.js";

export interface ContextInput {
  userId: string;
  inboundText?: string;
  wakeup?: string;
  excludeMessageId?: string;
  excludeMessageIds?: readonly string[];
  images?: readonly InboundImage[];
}

export class ContextBuilder {
  constructor(
    private readonly memory: MemoryService,
    private readonly clock: Clock,
    private readonly persona: string,
    private readonly guardrails: string,
    private readonly toolGuidance: string,
    private readonly ngambekEnabled = false,
    private readonly ownerName = "Sayang",
  ) {}

  static async load(memory: MemoryService, clock: Clock, harnessDirectory = "harness", ngambekEnabled = false, ownerName = "Sayang"): Promise<ContextBuilder> {
    const [persona, guardrails, toolGuidance] = await Promise.all([
      readFile(join(harnessDirectory, "persona.md"), "utf8"),
      readFile(join(harnessDirectory, "guardrails.md"), "utf8"),
      readFile(join(harnessDirectory, "tool-guidance.md"), "utf8"),
    ]);
    return new ContextBuilder(memory, clock, persona, guardrails, toolGuidance, ngambekEnabled, ownerName);
  }

  async build(input: ContextInput): Promise<LLMMessage[]> {
    const exported = this.memory.exportOwner(input.userId);
    const state = this.memory.getPromptState(input.userId);
    const personaState = this.memory.getPersonaState(input.userId);
    const now = this.clock.now();
    const mood = computeMood({ now, timeZone: exported.owner.timezone, lastUserMessageAt: state.lastUserMessageAt, state: personaState, ngambekEnabled: this.ngambekEnabled });
    const living = tickLivingState(personaState, { now, lastUserMessageAt: state.lastUserMessageAt, seed: input.userId });
    this.memory.setPersonaState(input.userId, living);
    const agenda = exported.commitments.filter((item) => item.status === "pending" && item.eventAt !== null && item.eventAt >= now - 86_400_000 && item.eventAt <= now + 3 * 86_400_000);
    const dynamic = [
      `Panggilan owner: "${this.ownerName}". Pakai ini (atau variasi manja singkatnya) sebagai panggilan utama; jangan mengulang "sayang" di tiap pesan.`,
      `Waktu sekarang: ${new Intl.DateTimeFormat("id-ID", { dateStyle: "full", timeStyle: "short", timeZone: exported.owner.timezone }).format(now)} (zona ${exported.owner.timezone}; tanggal ISO ${new Intl.DateTimeFormat("sv-SE", { timeZone: exported.owner.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}). Acuan tanggal: sapaan pagi/siang/sore/malam ikut jam lokal ini; kalau owner minta jam yang belum lewat hari ini (mis. "nanti jam 3"), jadwalkan HARI INI, bukan besok.`,
      `Jeda sejak chat terakhir owner: ${state.lastUserMessageAt === null ? "Belum ada" : formatElapsed(now - state.lastUserMessageAt)}`,
      `Keadaan sekarang: ${renderStateCue(living, mood)}`,
      `Fakta aktif:\n${exported.facts.map((fact) => `- ${fact.content}`).join("\n") || "- Belum ada"}`,
      `Agenda H-1 s/d H+3:\n${agenda.map((item) => `- ${item.title}; acara: ${formatTime(item.eventAt, exported.owner.timezone)}; ingatkan: ${formatTime(item.remindAt, exported.owner.timezone)}; tindak lanjut: ${formatTime(item.followUpAt, exported.owner.timezone)}; konteks: ${item.contextNotes}`).join("\n") || "- Tidak ada"}`,
      `Ringkasan percakapan: ${state.summary ?? "Belum ada ringkasan."}`,
      `Hindari mengulang: pembuka ${list(personaState.recentOpenings)}; akhiran ${list(personaState.recentEndings)}; emoji terpakai ${list(personaState.recentEmojis)}`,
    ].join("\n\n");
    const history = pairedHistory(priorMessages(exported.messages, excludedIds(input)).slice(-20));
    const turn = input.inboundText ?? `[SYSTEM WAKEUP]\n${input.wakeup ?? "Mulai percakapan proaktif sesuai pemicu."}`;
    const turnParts = input.images?.length
      ? [{ type: "text" as const, text: turn }, ...input.images.map((img) => ({ type: "image_url" as const, dataUrl: img.dataUrl }))]
      : turn;
    return [{ role: "system", content: `${this.persona}\n\n${this.guardrails}\n\n${this.toolGuidance}\n\n${dynamic}` }, ...history, { role: "user", content: turnParts }];
  }
}

function excludedIds(input: ContextInput): ReadonlySet<string> {
  const ids = new Set(input.excludeMessageIds ?? []);
  if (input.excludeMessageId !== undefined) ids.add(input.excludeMessageId);
  return ids;
}

function priorMessages<T extends { id: string }>(messages: readonly T[], exclude: ReadonlySet<string>): readonly T[] {
  return exclude.size === 0 ? messages : messages.filter((message) => !exclude.has(message.id));
}

function pairedHistory(messages: readonly import("../memory/service.js").StoredMessage[]): LLMMessage[] {
  const history: LLMMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      const results = messages.slice(index + 1, index + 1 + message.toolCalls.length);
      if (results.length === message.toolCalls.length && results.every((result, resultIndex) => result?.role === "tool" && result.toolCallId === message.toolCalls?.[resultIndex]?.id && result.content !== null)) {
        history.push({ role: "assistant", content: message.content, toolCalls: message.toolCalls as [typeof message.toolCalls[number], ...typeof message.toolCalls] });
        for (const result of results) history.push({ role: "tool", content: result.content!, toolCallId: result.toolCallId! });
        index += results.length;
      }
      continue;
    }
    if (message.role === "tool" || message.content === null) continue;
    history.push({ role: message.role, content: message.content });
  }
  return history;
}

function formatTime(value: number | null, timeZone: string): string {
  return value === null ? "tidak dijadwalkan" : new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short", timeZone }).format(value);
}

function formatElapsed(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} menit yang lalu`;
  return `${Math.floor(minutes / 60)} jam ${minutes % 60} menit yang lalu`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "belum ada" : values.join(", ");
}
