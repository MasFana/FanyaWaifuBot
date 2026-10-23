import { z } from "zod";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const isIanaTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const environmentSchema = z.object({
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("gpt-4o"),
  LLM_EXTRACTOR_MODEL: z.string().min(1).default("gpt-4o-mini"),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_OWNER_ID: z.string().regex(/^\d*$/, "TELEGRAM_OWNER_ID must contain only digits").default(""),
  OWNER_DISPLAY_NAME: z.string().min(1).default("Sayang"),
  OWNER_TIMEZONE: z.string().min(1).refine(isIanaTimeZone, "OWNER_TIMEZONE must be a valid IANA timezone").default("Asia/Jakarta"),
  QUIET_HOURS_START: z.string().regex(timePattern, "QUIET_HOURS_START must be HH:mm").default("23:30"),
  QUIET_HOURS_END: z.string().regex(timePattern, "QUIET_HOURS_END must be HH:mm").default("06:30"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  SPONTANEOUS_IDLE_HOURS: z.coerce.number().positive().default(6),
  MAX_UNANSWERED_PROACTIVE: z.coerce.number().int().nonnegative().default(2),
  REPLY_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(4_000),
  REPLY_DEFER_EXTRA_MS: z.coerce.number().int().nonnegative().default(60_000),
  REPLY_MAX_BUBBLES: z.coerce.number().int().positive().default(4),
  FOCUS_DEFER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  NGAMBEK_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  DATABASE_PATH: z.string().min(1).default("./data/fanya.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface AppConfig {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    extractorModel: string;
  };
  telegram: {
    botToken: string;
    ownerId: string | undefined;
  };
  owner: {
    displayName: string;
    timezone: string;
  };
  heartbeat: {
    intervalMs: number;
    quietHours: { start: string; end: string };
    spontaneousIdleHours: number;
    maxUnansweredProactive: number;
  };
  replies: {
    debounceMs: number;
    deferExtraMs: number;
    maxBubbles: number;
    focusDeferThreshold: number;
    ngambekEnabled: boolean;
  };
  databasePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(env);
  const isTest = env["NODE_ENV"] === "test";

  if (!isTest && !parsed.LLM_API_KEY) {
    throw new Error("LLM_API_KEY is required");
  }

  if (!isTest && !parsed.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  return {
    llm: {
      baseUrl: parsed.LLM_BASE_URL,
      apiKey: parsed.LLM_API_KEY,
      model: parsed.LLM_MODEL,
      extractorModel: parsed.LLM_EXTRACTOR_MODEL,
    },
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      ownerId: parsed.TELEGRAM_OWNER_ID || undefined,
    },
    owner: {
      displayName: parsed.OWNER_DISPLAY_NAME,
      timezone: parsed.OWNER_TIMEZONE,
    },
    heartbeat: {
      intervalMs: parsed.HEARTBEAT_INTERVAL_MS,
      quietHours: { start: parsed.QUIET_HOURS_START, end: parsed.QUIET_HOURS_END },
      spontaneousIdleHours: parsed.SPONTANEOUS_IDLE_HOURS,
      maxUnansweredProactive: parsed.MAX_UNANSWERED_PROACTIVE,
    },
    replies: {
      debounceMs: parsed.REPLY_DEBOUNCE_MS,
      deferExtraMs: parsed.REPLY_DEFER_EXTRA_MS,
      maxBubbles: parsed.REPLY_MAX_BUBBLES,
      focusDeferThreshold: parsed.FOCUS_DEFER_THRESHOLD,
      ngambekEnabled: parsed.NGAMBEK_ENABLED,
    },
    databasePath: parsed.DATABASE_PATH,
    logLevel: parsed.LOG_LEVEL,
  };
}
