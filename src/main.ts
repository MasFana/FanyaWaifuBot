import "dotenv/config";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import type { AppConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { Agent } from "./core/agent.js";
import { HeartbeatEngine } from "./core/heartbeat.js";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import { ContextBuilder } from "./core/context.js";
import type { LLMProvider } from "./llm/provider.js";
import { createOpenAIProvider } from "./llm/openai.js";
import { migrate, openDatabase } from "./db/index.js";
import { MemoryService } from "./memory/service.js";
import { PostTurnWriter } from "./memory/writer.js";
import { createMemorySearchTool } from "./tools/memory-search.js";
import { createScheduleTools } from "./tools/schedule.js";
import { createBuiltinTools, ToolRegistry } from "./tools/index.js";
import { discoverTools } from "./tools/index.js";
import { TelegramChannel } from "./channels/telegram.js";
import type { Delay, TelegramBot } from "./channels/telegram.js";
import { OwnerQueue } from "./core/owner-queue.js";

export interface Application {
  readonly memory: MemoryService;
  readonly channel: TelegramChannel;
  readonly heartbeat: HeartbeatEngine;
  readonly writer: PostTurnWriter;
  readonly ownerId: string;
  readonly tools: readonly string[];
  receive(update: { id: string; fromId: string; text: string }): Promise<void>;
  writerIdle(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ApplicationOptions {
  config: AppConfig;
  database: Database.Database;
  clock: Clock;
  provider: LLMProvider;
  bot?: TelegramBot;
  delay?: Delay;
  harnessDirectory?: string;
  toolDirectory?: string;
}

export interface StartupRuntime {
  bot?: TelegramBot;
  openDatabase?: typeof openDatabase;
  migrate?: typeof migrate;
  provider?: typeof createOpenAIProvider;
  application?: (options: ApplicationOptions) => Promise<Application>;
}

export async function createApplication(options: ApplicationOptions): Promise<Application> {
    const { config, database, clock, provider } = options;
  try {
    const memory = new MemoryService(database, clock);
    const queue = new OwnerQueue();
    const context = await ContextBuilder.load(memory, clock, options.harnessDirectory ?? "harness", config.replies.ngambekEnabled);
    const writer = new PostTurnWriter(provider, memory, clock, config.llm.extractorModel);
    const builtins = [
      ...createBuiltinTools({ clock, timeZone: config.owner.timezone }),
      createMemorySearchTool(memory),
      ...createScheduleTools(memory, clock),
    ];
    const builtinNames = new Set(builtins.map((tool) => tool.name));
    const discovered = (await discoverTools(options.toolDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "tools")))
      .filter((tool) => !builtinNames.has(tool.name));
    const definitions = [...builtins, ...discovered];
    const tools = new ToolRegistry(definitions);
    const channel = new TelegramChannel(config, memory, clock, options.bot, options.delay, queue);
    const agent = new Agent(provider, memory, tools, channel, context, clock, config.llm.model, writer);
    channel.setAgent(agent);
    const heartbeat = new HeartbeatEngine(memory, agent, clock, config, queue, (userId) => channel.flushPending(userId));
    const ownerId = config.telegram.ownerId ?? memory.resolveClaimedOwner("telegram")?.externalId ?? "";
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
      await heartbeat.stop();
      channel.stop();
      await writer.awaitIdle();
      database.close();
    })();
    return {
      memory, channel, heartbeat, writer, ownerId,
      tools: tools.definitions().map((tool) => tool.name),
      receive: (update) => channel.receive(update),
      writerIdle: () => writer.awaitIdle(),
      shutdown,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function startApplication(config = loadConfig(process.env), runtime: StartupRuntime = {}): Promise<() => void> {
  const databaseDirectory = dirname(resolve(config.databasePath));
  if (databaseDirectory !== "." && !existsSync(databaseDirectory)) mkdirSync(databaseDirectory, { recursive: true });
  const clock = new SystemClock();
  const database = (runtime.openDatabase ?? openDatabase)(config.databasePath);
  let heartbeatStarted = false;
  let channelStartAttempted = false;
  let app: Application | undefined;
  try {
    (runtime.migrate ?? migrate)(database, clock);
    const provider = (runtime.provider ?? createOpenAIProvider)(config.llm.apiKey, config.llm.baseUrl, config.llm.model);
    const readyApp = await (runtime.application ?? createApplication)({ config, database, clock, provider, ...(runtime.bot === undefined ? {} : { bot: runtime.bot }) });
    app = readyApp;
    readyApp.heartbeat.start();
    heartbeatStarted = true;
    channelStartAttempted = true;
    await readyApp.channel.start();
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = readyApp.shutdown();
      return shutdownPromise;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return shutdown;
  } catch (error) {
    // Startup may partially enter channel.start before rejecting.
     if (app !== undefined && channelStartAttempted) app.channel.stop();
     if (app !== undefined && heartbeatStarted) await app.heartbeat.stop();
     if (app !== undefined) await app.writer.awaitIdle();
     database.close();
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await startApplication();
}
