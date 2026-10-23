import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { TelegramChannel, type TelegramBot } from "../src/channels/telegram.js";
import { FrozenClock } from "../src/core/clock.js";
import type { OutboundMedia } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeBot implements TelegramBot {
  readonly messages: string[] = [];
  readonly media: Array<{ chatId: string; media: OutboundMedia }> = [];
  fails = false;
  async sendMessage(_chatId: string, text: string): Promise<void> { this.messages.push(text); }
  async sendChatAction(): Promise<void> {}
  async sendDocument(): Promise<void> {}
  async sendMedia(chatId: string, media: OutboundMedia): Promise<void> {
    if (this.fails) throw new Error("Bad Request: file is too big");
    this.media.push({ chatId, media });
  }
  async start(): Promise<void> {}
  stop(): void {}
}

function setup(): { channel: TelegramChannel; bot: FakeBot } {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  const bot = new FakeBot();
  return { channel: new TelegramChannel(createTestConfig({ telegram: { botToken: "test-token", ownerId: "123" } }), memory, clock, bot, async () => {}), bot };
}

test("telegram channel sends media by url", async () => {
  const { channel, bot } = setup();

  const delivery = await channel.sendMedia("123", { kind: "video", url: "https://cdn/v.mp4", caption: "cap" });

  assert.equal(delivery, "media");
  assert.deepEqual(bot.media, [{ chatId: "123", media: { kind: "video", url: "https://cdn/v.mp4", caption: "cap" } }]);
});

test("telegram channel falls back to a text link when the media upload fails", async () => {
  const { channel, bot } = setup();
  bot.fails = true;

  const delivery = await channel.sendMedia("123", { kind: "video", url: "https://cdn/v.mp4", caption: "cap" });

  assert.equal(delivery, "link");
  assert.equal(bot.media.length, 0);
  assert.match(bot.messages.at(-1) ?? "", /https:\/\/cdn\/v\.mp4/u);
});
