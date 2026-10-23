import type { PersonaState } from "./persona-state.js";

export type Energy = "rendah" | "sedang" | "hangat";

export interface MoodState {
  energy: Energy;
  missYou: boolean;
  ngambek: boolean;
  affection: number;
  cue: string;
}

const missYouThresholdMs = 8 * 3_600_000;
const rudeDelta = -0.1;
const kindDelta = 0.05;
const cuekPhrases = ["ntahlah", "males", "diem aja", "terserah"];

export function computeMood(input: { now: number; timeZone: string; lastUserMessageAt: number | null; state: PersonaState }): MoodState {
  const hour = localHour(input.now, input.timeZone);
  const energy: Energy = hour < 7 ? "rendah" : hour >= 17 && hour < 21 ? "hangat" : "sedang";
  const missYou = input.lastUserMessageAt !== null && input.now - input.lastUserMessageAt > missYouThresholdMs;
  const ngambek = input.state.ngambekUntil !== null && input.now < input.state.ngambekUntil;
  const affection = Number.isFinite(input.state.affection) ? input.state.affection : 0;
  return { energy, missYou, ngambek, affection, cue: buildCue(energy, missYou, ngambek, affection) };
}

export function applyOwnerSentiment(state: PersonaState, text: string, _now: number): PersonaState {
  if (text.trimStart().startsWith("[SYSTEM")) return state;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const cuek = normalized === "gpp" || cuekPhrases.some((phrase) => normalized.includes(phrase));
  const affection = clamp(state.affection + (cuek ? rudeDelta : kindDelta), 0, 1);
  return { ...state, affection };
}

function localHour(now: number, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number.parseInt(formatted, 10);
}

function buildCue(energy: Energy, missYou: boolean, ngambek: boolean, affection: number): string {
  const parts = [energyWord(energy)];
  if (missYou) parts.push("kangen karena kamu lama ga nyapa");
  if (ngambek) parts.push("masih ngambek");
  parts.push(`afeksi ${affection.toFixed(1)}`);
  return parts.join("; ");
}

function energyWord(energy: Energy): string {
  if (energy === "rendah") return "ngantuk";
  return energy === "hangat" ? "hangat" : "biasa aja";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}