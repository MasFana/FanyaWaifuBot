import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { openDatabase, migrate } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";
import {
  TelegramChannel,
  formatReplyQuote,
  toDataUrl,
  truncateQuote,
  type TelegramBot,
} from "../src/channels/telegram.js";
import type { InboundEvent } from "../src/core/types.js";
import { createTestConfig } from "./helpers.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

class FakeBot implements TelegramBot {
  async sendMessage(): Promise<void> {}
  async sendChatAction(): Promise<void> {}
  async sendDocument(): Promise<void> {}
  async sendMedia(): Promise<void> {}
  async start(): Promise<void> {}
  stop(): void {}
}

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);
  migrate(database, clock);
  const memory = new MemoryService(database, clock);
  memory.ensureOwner("telegram", "123");
  const base = createTestConfig();
  const channel = new TelegramChannel(
    { ...base, telegram: { botToken: "test-token", ownerId: "123" }, replies: { ...base.replies, debounceMs: 0 } },
    memory, clock, new FakeBot(), async () => {},
  );
  const events: InboundEvent[] = [];
  channel.setAgent({ runInbound: async (event) => { events.push(event); } });
  return { channel, memory, events };
}

test("reply to Fanya prefixes the quote line and marks it as the bot's message", async () => {
  const { channel, events } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "ini maksudnya?", replyToText: "kamu udah makan?", replyToFromBot: true });

  assert.equal(events.length, 1);
  assert.ok(events[0]!.text.startsWith(`[Membalas pesanmu: "kamu udah makan?"]`), events[0]!.text);
  assert.equal(events[0]!.text, `[Membalas pesanmu: "kamu udah makan?"]\nini maksudnya?`);
});

test("reply to someone else uses the previous-message prefix", async () => {
  const { channel, events } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "oh gitu", replyToText: "besok ya", replyToFromBot: false });

  assert.equal(events[0]!.text, `[Membalas pesan sebelumnya: "besok ya"]\noh gitu`);
});

test("a quote longer than 220 characters is truncated with an ellipsis", async () => {
  const { channel, events } = setup();
  const long = "a".repeat(250);

  await channel.receive({ id: "m1", fromId: "123", text: "iya", replyToText: long, replyToFromBot: true });

  const text = events[0]!.text;
  assert.ok(text.includes(`${"a".repeat(220)}...`), "quote truncated to 220 chars plus ellipsis");
  assert.ok(text.startsWith("[Membalas pesanmu: "));
});

test("photo with a caption carries the marker, the caption, and the image data URL", async () => {
  const { channel, memory, events } = setup();
  const image = { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" };

  await channel.receive({ id: "m1", fromId: "123", text: "Lagi makan ketoprak nih", images: [image] });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "[Mengirim foto] Lagi makan ketoprak nih");
  assert.equal(events[0]!.images?.[0]?.dataUrl, "data:image/jpeg;base64,AAAA");
  const stored = memory.exportOwner("123").messages.find((message) => message.role === "user");
  assert.ok(stored?.content?.includes("[Mengirim foto]"));
});

test("photo without a caption still runs the turn with just the marker", async () => {
  const { channel, events } = setup();

  await channel.receive({ id: "m1", fromId: "123", images: [{ dataUrl: "data:image/png;base64,BBBB", mimeType: "image/png" }] });

  assert.equal(events.length, 1);
  assert.equal(events[0]!.text, "[Mengirim foto]");
  assert.equal(events[0]!.images?.[0]?.mimeType, "image/png");
});

test("reply and photo combine as quote line then marker with caption", async () => {
  const { channel, events } = setup();

  await channel.receive({
    id: "m1", fromId: "123", text: "ini nih", replyToText: "makan apa?", replyToFromBot: true,
    images: [{ dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" }],
  });

  assert.equal(events[0]!.text, `[Membalas pesanmu: "makan apa?"]\n[Mengirim foto] ini nih`);
});

test("plain text without reply or image is unchanged", async () => {
  const { channel, events } = setup();

  await channel.receive({ id: "m1", fromId: "123", text: "halo sayang" });

  assert.equal(events[0]!.text, "halo sayang");
  assert.equal(events[0]!.images, undefined);
});

test("truncateQuote and toDataUrl helpers", () => {
  assert.equal(truncateQuote("pendek"), "pendek");
  assert.equal(truncateQuote("b".repeat(250)), `${"b".repeat(220)}...`);
  assert.equal(truncateQuote("c".repeat(250), 10), `${"c".repeat(10)}...`);
  assert.equal(toDataUrl(Buffer.from([0x41, 0x41]), "image/jpeg"), "data:image/jpeg;base64,QUE=");
  assert.equal(formatReplyQuote("hai", true), `[Membalas pesanmu: "hai"]`);
  assert.equal(formatReplyQuote("hai", false), `[Membalas pesan sebelumnya: "hai"]`);
});
