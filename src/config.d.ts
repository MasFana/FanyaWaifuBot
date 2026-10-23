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
        quietHours: {
            start: string;
            end: string;
        };
        spontaneousIdleHours: number;
        maxUnansweredProactive: number;
    };
    databasePath: string;
    logLevel: "debug" | "info" | "warn" | "error";
}
export declare function loadConfig(env: NodeJS.ProcessEnv): AppConfig;
