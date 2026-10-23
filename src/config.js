import { z } from "zod";
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const environmentSchema = z.object({
    LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
    LLM_API_KEY: z.string().min(1, "LLM_API_KEY is required"),
    LLM_MODEL: z.string().min(1).default("gpt-4o"),
    LLM_EXTRACTOR_MODEL: z.string().min(1).default("gpt-4o-mini"),
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_OWNER_ID: z.string().regex(/^\d*$/, "TELEGRAM_OWNER_ID must contain only digits").default(""),
    OWNER_DISPLAY_NAME: z.string().min(1).default("Sayang"),
    OWNER_TIMEZONE: z.string().min(1).default("Asia/Jakarta"),
    QUIET_HOURS_START: z.string().regex(timePattern, "QUIET_HOURS_START must be HH:mm").default("23:30"),
    QUIET_HOURS_END: z.string().regex(timePattern, "QUIET_HOURS_END must be HH:mm").default("06:30"),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    SPONTANEOUS_IDLE_HOURS: z.coerce.number().positive().default(6),
    MAX_UNANSWERED_PROACTIVE: z.coerce.number().int().nonnegative().default(2),
    DATABASE_PATH: z.string().min(1).default("./data/fanya.db"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export function loadConfig(env) {
    const parsed = environmentSchema.parse(env);
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
        databasePath: parsed.DATABASE_PATH,
        logLevel: parsed.LOG_LEVEL,
    };
}
//# sourceMappingURL=config.js.map