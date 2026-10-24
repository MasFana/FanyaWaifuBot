import type { MoodState } from "./mood.js";
import type { Activity, PersonaState } from "./persona-state.js";

/** Aktivitas solo Fanya saat tidak sedang mengobrol — dunianya sendiri. */
export const activityPool: readonly string[] = [
  "baca novel bab terakhir",
  "main game indie sambil rebahan",
  "dengerin anisong",
  "rapiin rak buku",
  "nyeduh matcha",
];

// ponytail: initial tuning constants. Kalibrasi lewat log ~1 minggu, lalu sesuaikan.
const activityMinMs = 20 * 60_000;
const activityMaxMs = 120 * 60_000;
const companyRatePerMs = 0.1 / 3_600_000;
const decayRatePerMs = 0.05 / 3_600_000;
const focusDecayPerMs = 0.4 / 3_600_000;
const boundaryDecayPerMs = 0.05 / 3_600_000;
const silenceForCompanyMs = 60 * 60_000;
const shareOnFinish = 0.3;
const focusOnStart = 0.8;

/**
 * Memajukan dunia Fanya secara deterministik (tanpa LLM): memilih/menyelesaikan
 * aktivitas solo dan menggeser drives. Dipanggil saat context build dan heartbeat.
 */
export function tickLivingState(state: PersonaState, input: { now: number; lastUserMessageAt: number | null; seed: string }): PersonaState {
  const { now, lastUserMessageAt, seed } = input;
  const elapsed = Math.max(0, now - state.updatedAt);
  const drives = { ...state.drives };
  let activity: Activity | null = state.activity;

  if (activity === null) {
    activity = pickActivity(seed, now);
    drives.focus = clamp(focusOnStart);
  } else if (now >= activity.endsAt) {
    activity = null;
    drives.wantToShare = clamp(drives.wantToShare + shareOnFinish);
  }

  if (lastUserMessageAt !== null && now - lastUserMessageAt > silenceForCompanyMs) {
    drives.wantCompany = clamp(drives.wantCompany + companyRatePerMs * elapsed);
  } else {
    drives.wantCompany = clamp(drives.wantCompany - companyRatePerMs * elapsed);
  }
  drives.wantToShare = clamp(drives.wantToShare - decayRatePerMs * elapsed);
  drives.focus = clamp(drives.focus - focusDecayPerMs * elapsed);
  drives.boundary = clamp(drives.boundary - boundaryDecayPerMs * elapsed);

  return { ...state, activity, drives, updatedAt: now };
}

/** Merender LivingState jadi cue bahasa manusia untuk prompt (tanpa angka bila tak hingga). */
export function renderStateCue(state: PersonaState, mood: MoodState): string {
  const parts: string[] = [];
  if (state.activity !== null) parts.push(`lagi ${state.activity.name}`);
  parts.push(`energi ${mood.energy}`);
  parts.push(`afeksi ${Number.isFinite(state.affection) ? state.affection.toFixed(1) : "0.7"}`);
  if (mood.missYou) parts.push("kangen");

  const drives = state.drives;
  if (drives.wantToShare >= 0.5) parts.push("pengen cerita atau pamer sesuatu");
  if (drives.wantCompany >= 0.5) parts.push("pengen ditemenin");
  if (drives.focus >= 0.6) parts.push("lagi fokus, agak males diganggu");
  if (drives.boundary >= 0.5) parts.push("lagi sensitif, bisa bantah");

  return parts.join("; ");
}

/** Apakah Fanya sedang terlalu fokus sampai lebih baik menunda balasan hidup. */
export function decideReply(state: PersonaState, input: { focusThreshold: number }): "reply" | "defer" {
  return state.activity !== null && state.drives.focus >= input.focusThreshold ? "defer" : "reply";
}

function pickActivity(seed: string, now: number): Activity {
  const bucket = Math.floor(now / activityMinMs);
  const name = activityPool[hash(`${seed}:${bucket}`) % activityPool.length] ?? activityPool[0]!;
  const span = activityMaxMs - activityMinMs;
  const duration = activityMinMs + (hash(`${seed}:${bucket}:duration`) % span);
  return { name, endsAt: now + duration };
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}