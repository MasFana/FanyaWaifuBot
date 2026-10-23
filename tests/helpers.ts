import type { AppConfig } from "../src/config.js";

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    llm: {
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-key",
      model: "test-model",
      extractorModel: "test-extractor-model",
    },
    telegram: { botToken: "test-token", ownerId: undefined },
    owner: { displayName: "Sayang", timezone: "Asia/Jakarta" },
    heartbeat: {
      intervalMs: 60_000,
      quietHours: { start: "23:30", end: "06:30" },
      spontaneousIdleHours: 6,
      maxUnansweredProactive: 2,
    },
    databasePath: ":memory:",
    logLevel: "error",
    ...overrides,
  };
}
