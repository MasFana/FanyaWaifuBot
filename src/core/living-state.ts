import type { MoodState } from "./mood.js";
import { localHour } from "./mood.js";
import type { Activity, PersonaState } from "./persona-state.js";

export const subuhActivities: readonly string[] = [
  "rebahan sambil meluk guling, setengah merem",
  "kebangun gara-gara haus, lagi ngumpulin nyawa di kasur",
  "dengerin playlist lagu pelan sambil merem melek",
];

export const pagiActivities: readonly string[] = [
  "baru beres mandi, lagi ngeringin rambut sambil scroll hp",
  "nyeduh teh hangat sambil nyari cemilan pagi",
  "rapiin kamar sama meja dikit biar ga berantakan",
  "baca lanjutan webtoon/novel yang semalem ketunda",
];

export const siangSoreActivities: readonly string[] = [
  "main game indie santai sambil rebahan di sofa",
  "nyeduh matcha dingin sambil dengerin anisong",
  "baca novel bab terakhir, lagi seru banget ceritanya",
  "iseng nyobain resep cemilan simpel di dapur",
  "rebahan santai sambil nonton video kucing lewat di timeline",
];

export const malamActivities: readonly string[] = [
  "selesai bersih-bersih badan, lagi santai di kasur",
  "dengerin lagu chill malam sambil baca-baca cerita",
  "main game santai bentar sebelum ngantuk",
  "lagi skincare-an tipis-tipis sambil rebahan",
];

/** Aktivitas solo Fanya saat tidak sedang mengobrol — dunianya sendiri. */
export const activityPool: readonly string[] = [
  ...subuhActivities,
  ...pagiActivities,
  ...siangSoreActivities,
  ...malamActivities,
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
const initiativeThreshold = 0.6;
/** Jendela "owner baru saja aktif"; di dalam ini Fanya tidak menaikkan drive inisiatif. */
export const recentOwnerActivityMs = 30 * 60_000;
const wantToShareCapAfterOwner = 0.25;

/**
 * Memajukan dunia Fanya secara deterministik (tanpa LLM): memilih/menyelesaikan
 * aktivitas solo dan menggeser drives. Dipanggil saat context build dan heartbeat.
 */
export function tickLivingState(state: PersonaState, input: { now: number; lastUserMessageAt: number | null; seed: string; hour?: number; timeZone?: string }): PersonaState {
  const { now, lastUserMessageAt, seed } = input;
  const hour = input.hour ?? (input.timeZone ? localHour(now, input.timeZone) : undefined);
  const elapsed = Math.max(0, now - state.updatedAt);
  const drives = { ...state.drives };
  const recentlyActive = lastUserMessageAt !== null && now - lastUserMessageAt <= recentOwnerActivityMs;
  let activity: Activity | null = state.activity;

  if (activity === null || now >= activity.endsAt) {
    if (activity !== null && !recentlyActive) drives.wantToShare = clamp(drives.wantToShare + shareOnFinish);
    activity = pickActivity(seed, now, hour);
    drives.focus = clamp(focusOnStart);
  }

  if (lastUserMessageAt !== null && now - lastUserMessageAt > silenceForCompanyMs) {
    drives.wantCompany = clamp(drives.wantCompany + companyRatePerMs * elapsed);
  } else {
    drives.wantCompany = clamp(drives.wantCompany - companyRatePerMs * elapsed);
  }
  drives.wantToShare = clamp(drives.wantToShare - decayRatePerMs * elapsed);
  drives.focus = clamp(drives.focus - focusDecayPerMs * elapsed);
  drives.boundary = clamp(drives.boundary - boundaryDecayPerMs * elapsed);

  if (recentlyActive) {
    drives.wantCompany = 0;
    drives.wantToShare = Math.min(drives.wantToShare, wantToShareCapAfterOwner);
  }

  // Pengaman anti-spam: drive yang sudah melewati threshold pada state sebelumnya
  // dikuras ke 0 supaya tidak bisa memicu shouldInitiate dua tick berturut-turut.
  if (elapsed > 0) {
    if (state.drives.wantToShare >= initiativeThreshold) drives.wantToShare = 0;
    if (state.drives.wantCompany >= initiativeThreshold) drives.wantCompany = 0;
  }

  return { ...state, activity, drives, updatedAt: now };
}

/** Menguras drive inisiatif setelah proaktif dikirim agar tidak terpicu berulang. */
export function consumeInitiative(state: PersonaState, now?: number): PersonaState {
  return {
    ...state,
    drives: { ...state.drives, wantToShare: 0, wantCompany: 0 },
    ...(now === undefined ? {} : { updatedAt: now }),
  };
}

/** Merender LivingState jadi cue bahasa manusia untuk prompt (tanpa angka bila tak hingga). */
export function renderStateCue(state: PersonaState, mood: MoodState): string {
  const parts: string[] = [mood.cue];
  if (state.activity !== null) {
    parts.push(`lagi ${state.activity.name}`);
  }
  const aff = Number.isFinite(state.affection) ? state.affection : 0.7;
  parts.push(aff >= 0.8 ? "perasaan lagi sayang & manja banget" : aff >= 0.55 ? "perasaan hangat & nyaman" : "perasaan lagi agak bete/sensitif");

  const drives = state.drives;
  if (drives.wantToShare >= 0.45) parts.push("punya cerita/pikiran random dari kegiatan barusan yang pengen dibagi ke pacar kalau pas momennya");
  if (drives.wantCompany >= 0.45) parts.push("lagi pengen diperhatiin dan ditemenin ngobrol");
  if (drives.focus >= 0.6 && mood.energy !== "rendah") parts.push("lagi cukup asik sama kegiatan sendiri");
  if (drives.boundary >= 0.45) parts.push("lagi punya pendirian kuat, berani ngambek tipis atau nolak manja kalau digodain berlebihan");

  return parts.join("; ");
}

/** Apakah Fanya sedang terlalu fokus sampai lebih baik menunda balasan hidup. */
export function decideReply(state: PersonaState, input: { focusThreshold: number }): "reply" | "defer" {
  return state.activity !== null && state.drives.focus >= input.focusThreshold ? "defer" : "reply";
}

/** Inisiatif proaktif murni dari drives — null bila tidak ada dorongan yang cukup kuat. */
export function shouldInitiate(state: PersonaState): "share" | "company" | null {
  if (state.drives.wantToShare >= initiativeThreshold) return "share";
  if (state.drives.wantCompany >= initiativeThreshold) return "company";
  return null;
}

export function getPoolForHour(hour?: number): readonly string[] {
  if (hour === undefined) return activityPool;
  if (hour < 7) return subuhActivities;
  if (hour < 12) return pagiActivities;
  if (hour < 18) return siangSoreActivities;
  return malamActivities;
}

function pickActivity(seed: string, now: number, hour?: number): Activity {
  const bucket = Math.floor(now / activityMinMs);
  const pool = getPoolForHour(hour);
  const name = pool[hash(`${seed}:${bucket}`) % pool.length] ?? pool[0]!;
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