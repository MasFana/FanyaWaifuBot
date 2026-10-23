import { z } from "zod";

export interface PersonaState {
  affection: number;
  ngambekUntil: number | null;
  recentOpenings: string[];
  recentEndings: string[];
  recentEmojis: string[];
}

export interface Traits {
  opening: string;
  ending: string;
  emojis: string[];
}

export const defaultPersonaState: PersonaState = {
  affection: 0.7,
  ngambekUntil: null,
  recentOpenings: [],
  recentEndings: [],
  recentEmojis: [],
};

const personaStateSchema = z.object({
  affection: z.number(),
  ngambekUntil: z.number().nullable(),
  recentOpenings: z.array(z.string()),
  recentEndings: z.array(z.string()),
  recentEmojis: z.array(z.string()),
});

const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
const edgePunctuation = /^[\p{P}]+|[\p{P}]+$/gu;
const maxOpeningWords = 3;

export function parsePersonaState(json: string | null): PersonaState {
  if (json === null) return defaultPersonaState;
  try {
    const parsed = personaStateSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : defaultPersonaState;
  } catch {
    return defaultPersonaState;
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
  const added = incoming.filter((value) => value.length > 0);
  return [...existing, ...added].slice(-cap);
}

function cleanWord(word: string): string {
  return word.toLowerCase().replace(edgePunctuation, "");
}
