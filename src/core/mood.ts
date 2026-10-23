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
const affectionBaseline = 0.7;
const affectionTauMs = 6 * 3_600_000;
const ngambekDurationMs = 5 * 3_600_000;
// ponytail: ngambek influence is log-only until a calibration log is reviewed and the
// wording is tuned; remove the console.warn and flip this to true once calibrated.
const ngambekInfluenceEnabled = false;

export function computeMood(input: { now: number; timeZone: string; lastUserMessageAt: number | null; state: PersonaState }): MoodState {
  const hour = localHour(input.now, input.timeZone);
  const energy: Energy = hour < 7 || hour >= 21 ? "rendah" : hour >= 17 ? "hangat" : "sedang";
  const missYou = input.lastUserMessageAt !== null && input.now - input.lastUserMessageAt > missYouThresholdMs;
  const rawNgambek = input.state.ngambekUntil !== null && input.now < input.state.ngambekUntil;
  if (rawNgambek && !ngambekInfluenceEnabled) console.warn("[mood] ngambek decision", { now: input.now });
  const ngambek = ngambekInfluenceEnabled ? rawNgambek : false;
  const affection = Number.isFinite(input.state.affection) ? input.state.affection : 0;
  return { energy, missYou, ngambek, affection, cue: buildCue(energy, missYou, ngambek, affection) };
}

export function applyOwnerSentiment(state: PersonaState, text: string, now: number): PersonaState {
  if (text.trimStart().startsWith("[SYSTEM")) return state;
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  const cuek = isCuek(normalized);
  const decayed = decayAffection(state.affection, state.updatedAt, now);
  const affection = clamp(decayed + (cuek ? rudeDelta : kindDelta), 0, 1);
  return { ...state, affection, ngambekUntil: cuek ? now + ngambekDurationMs : null, updatedAt: now };
}

function isCuek(normalized: string): boolean {
  if (/^gpp[.!?]*$/u.test(normalized)) return true;
  if (/\b(diem aja)\b/u.test(normalized)) return true;
  return normalized.split(" ").some((token) => /^(ntahlah|males|terserah)[.!?]*$/u.test(token));
}

function decayAffection(affection: number, updatedAt: number, now: number): number {
  if (!Number.isFinite(affection)) return affectionBaseline;
  const elapsed = now - updatedAt;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return affection;
  return affectionBaseline + (affection - affectionBaseline) * Math.exp(-elapsed / affectionTauMs);
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
