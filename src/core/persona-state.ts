import { z } from "zod";

export interface Activity {
  name: string;
  endsAt: number;
}

export interface Drives {
  wantCompany: number;
  wantToShare: number;
  focus: number;
  boundary: number;
}

export interface PersonaState {
  affection: number;
  ngambekUntil: number | null;
  recentOpenings: string[];
  recentEndings: string[];
  recentEmojis: string[];
  activity: Activity | null;
  drives: Drives;
  updatedAt: number;
}

export const defaultDrives: Drives = Object.freeze({ wantCompany: 0, wantToShare: 0, focus: 0, boundary: 0 });

export interface Traits {
  opening: string;
  ending: string;
  emojis: string[];
}

export const defaultPersonaState: PersonaState = Object.freeze({
  affection: 0.7,
  ngambekUntil: null,
  recentOpenings: [],
  recentEndings: [],
  recentEmojis: [],
  activity: null,
  drives: defaultDrives,
  updatedAt: 0,
});

const activitySchema = z.object({ name: z.string(), endsAt: z.number() });
const drivesSchema = z.object({
  wantCompany: z.number(),
  wantToShare: z.number(),
  focus: z.number(),
  boundary: z.number(),
});

const personaStateSchema = z.object({
  affection: z.number(),
  ngambekUntil: z.number().nullable(),
  recentOpenings: z.array(z.string()),
  recentEndings: z.array(z.string()),
  recentEmojis: z.array(z.string()),
  activity: activitySchema.nullable().default(null),
  drives: drivesSchema.default(() => ({ ...defaultDrives })),
  updatedAt: z.number().default(0),
});

const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?/gu;
const edgePunctuation = /^[\p{P}]+|[\p{P}]+$/gu;
const maxOpeningWords = 3;

export function parsePersonaState(json: string | null): PersonaState {
  if (json === null) return clonePersonaState(defaultPersonaState);
  try {
    const parsed = personaStateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : clonePersonaState(defaultPersonaState);
  } catch {
    return clonePersonaState(defaultPersonaState);
  }
}

export function extractTraits(text: string): Traits {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  return {
    opening: words.slice(0, maxOpeningWords).map(cleanWord).filter((word) => word.length > 0).join(" "),
    ending: cleanWord(words.at(-1) ?? ""),
    emojis: text.match(emojiPattern) ?? [],
  };
}

export function mergeTraits(state: PersonaState, traits: Traits, cap = 5): PersonaState {
  return {
    ...state,
    recentOpenings: append(state.recentOpenings, [traits.opening], cap),
    recentEndings: append(state.recentEndings, [traits.ending], cap),
    recentEmojis: append(state.recentEmojis, traits.emojis, cap),
  };
}

function append(existing: readonly string[], incoming: readonly string[], cap: number): string[] {
  const merged = [...existing];
  for (const value of incoming) {
    if (value.length === 0) continue;
    const duplicate = merged.indexOf(value);
    if (duplicate >= 0) merged.splice(duplicate, 1);
    merged.push(value);
  }
  return merged.slice(-cap);
}

function clonePersonaState(state: PersonaState): PersonaState {
  return {
    ...state,
    recentOpenings: [...state.recentOpenings],
    recentEndings: [...state.recentEndings],
    recentEmojis: [...state.recentEmojis],
    activity: state.activity === null ? null : { ...state.activity },
    drives: { ...state.drives },
  };
}

function cleanWord(word: string): string {
  return word.toLowerCase().replace(edgePunctuation, "");
}
