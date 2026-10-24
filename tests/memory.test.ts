import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { defaultPersonaState } from "../src/core/persona-state.js";
import type { CommitmentInput, FactInput, InboundEvent } from "../src/core/types.js";
import { migrate, openDatabase } from "../src/db/index.js";
import { MemoryService } from "../src/memory/service.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: Database.Database; memory: MemoryService } {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrate(database, new FrozenClock(1_729_648_000_000));
  return { database, memory: new MemoryService(database, new FrozenClock(1_729_648_000_000)) };
}

function inbound(id: string): InboundEvent {
  return { id, userId: "123", text: "Aku liburan ke Bandung", receivedAt: 1_729_648_000_000 };
}

test("claims owner once and resolves its durable identity", () => {
  const { memory } = setup();

  const owner = memory.claimOwner("telegram", "123");

  assert.equal(memory.resolveOwner("telegram", "123")?.id, owner?.id);
  assert.equal(memory.claimOwner("telegram", "456"), undefined);
});

test("records inbound once and appends searchable messages in one transaction", () => {
  const { database, memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);

  assert.equal(memory.recordInbound("telegram", inbound("42")), true);
  assert.equal(memory.recordInbound("telegram", inbound("42")), false);
  const message = memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: inbound("42").text });

  assert.equal(memory.search(owner.id, "liburan Bandung").messages[0]?.content, "Aku liburan ke Bandung");
  assert.deepEqual(
    database.prepare("SELECT count(*) AS n FROM messages_fts WHERE message_id = ?").get(message.id) as { n: number },
    { n: 1 },
  );
});

test("stores first image context for its owner and makes it searchable", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const other = memory.ensureOwner("telegram", "456");
  const message = memory.appendMessage(owner.id, { channel: "telegram", role: "user", content: "[Mengirim foto]" });

  memory.saveImageContext(owner.id, message.id, "Panel manhwa memperlihatkan dua tokoh di kamar.");
  memory.saveImageContext(owner.id, message.id, "harus diabaikan");

  assert.equal(memory.getImageContexts(owner.id, [message.id]).get(message.id)?.description, "Panel manhwa memperlihatkan dua tokoh di kamar.");
  assert.equal(memory.search(owner.id, "panel manhwa").messages.some((item) => item.id === message.id), true);
  assert.equal(memory.search(owner.id, "panel manhwa").imageContexts[0]?.description, "Panel manhwa memperlihatkan dua tokoh di kamar.");
  assert.equal(memory.saveImageContext(owner.id, "missing", "Tidak disimpan"), undefined);
  assert.equal(memory.getImageContexts(other.id, [message.id]).size, 0);
  assert.throws(() => memory.saveImageContext(owner.id, message.id, "a".repeat(601)), /600/);
});

test("round-trips persona state through users.settings_json and defaults on corrupt data", () => {
  const { database, memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);

  assert.deepEqual(memory.getPersonaState(owner.id), defaultPersonaState);

  const state = { ...defaultPersonaState, affection: 0.9, recentEndings: ["halo"], recentEmojis: ["🤍"] };
  memory.setPersonaState(owner.id, state);
  assert.deepEqual(memory.getPersonaState(owner.id), state);

  database.prepare("UPDATE users SET settings_json = ? WHERE id = ?").run("{broken", owner.id);
  assert.deepEqual(memory.getPersonaState(owner.id), defaultPersonaState);
});

test("replaces matching active fact and keeps current fact searchable", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const coffee: FactInput = { content: "Minuman favorit: kopi", category: "preferensi", origin: "stated" };
  const tea: FactInput = { content: "Minuman favorit: teh hijau", category: "preferensi", origin: "stated" };

  const oldFact = memory.upsertFact(owner.id, coffee);
  const replacement = memory.upsertFact(owner.id, tea);

  assert.equal(memory.getFact(oldFact.id)?.status, "replaced");
  assert.equal(memory.getFact(oldFact.id)?.replacedBy, replacement.id);
  assert.deepEqual(memory.search(owner.id, "teh hijau").facts.map((fact) => fact.content), ["Minuman favorit: teh hijau"]);
  assert.deepEqual(memory.listActiveFacts(owner.id).map((fact) => fact.content), ["Minuman favorit: teh hijau"]);
});

test("replaces natural preference statements sharing a bounded preference key", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);

  const coffee = memory.upsertFact(owner.id, { content: "Suka kopi", category: "preferensi", origin: "stated" });
  const tea = memory.upsertFact(owner.id, { content: "Suka teh hijau", category: "preferensi", origin: "stated" });

  assert.equal(memory.getFact(coffee.id)?.status, "replaced");
  assert.equal(memory.getFact(coffee.id)?.replacedBy, tea.id);
});

test("upserts nearest pending commitment and rejects nonfuture event", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const original: CommitmentInput = { title: "Presentasi proyek", eventAt: 1_729_652_000_000, contextNotes: "latihan" };

  const first = memory.upsertCommitment(owner.id, original);
  const updated = memory.upsertCommitment(owner.id, { ...original, eventAt: 1_729_652_060_000, contextNotes: "siapkan slide" });

  assert.equal(updated.id, first.id);
  assert.equal(memory.listPendingCommitments(owner.id)[0]?.contextNotes, "siapkan slide");
  assert.throws(() => memory.upsertCommitment(owner.id, { ...original, eventAt: 1_729_648_000_000 }), /future/);
});

test("updates same-title commitment within one day but inserts recurring far occurrence", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const first = memory.upsertCommitment(owner.id, { title: "Lari pagi", eventAt: 1_729_734_400_000, contextNotes: "minggu ini" });

  const corrected = memory.upsertCommitment(owner.id, { title: " LARI  PAGI ", eventAt: 1_729_735_600_000, contextNotes: "mundur" });
  const recurring = memory.upsertCommitment(owner.id, { title: "Lari pagi", eventAt: 1_730_339_200_000, contextNotes: "minggu depan" });

  assert.equal(corrected.id, first.id);
  assert.notEqual(recurring.id, first.id);
  assert.equal(memory.listPendingCommitments(owner.id).length, 2);
});

test("forgets exactly one matching active fact or pending commitment and exports owner data", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const tea = memory.upsertFact(owner.id, { content: "Suka teh hijau", category: "preferensi", origin: "stated" });
  memory.upsertCommitment(owner.id, { title: "Dokter gigi", eventAt: 1_729_652_000_000, contextNotes: "kontrol" });

  assert.deepEqual(memory.forget(owner.id, "teh hijau"), { outcome: "deleted", candidate: { kind: "fact", id: tea.id, content: "Suka teh hijau" } });
  assert.equal(memory.listActiveFacts(owner.id).length, 0);
  assert.equal(memory.forget(owner.id, "dokter").outcome, "deleted");
  assert.equal(memory.listPendingCommitments(owner.id).length, 0);
  assert.deepEqual(memory.exportOwner(owner.id).facts, []);
  assert.equal(memory.exportOwner(owner.id).commitments[0]?.status, "cancelled");
});

test("does not forget ambiguous matches and returns refinement candidates", () => {
  const { memory } = setup();
  const owner = memory.claimOwner("telegram", "123");
  assert.ok(owner);
  const tea = memory.upsertFact(owner.id, { content: "Minum teh pagi", category: "rutinitas", origin: "stated" });
  const doctor = memory.upsertCommitment(owner.id, { title: "Belanja teh", eventAt: 1_729_652_000_000, contextNotes: "pasar" });

  const result = memory.forget(owner.id, "teh");

  assert.deepEqual(result, {
    outcome: "ambiguous",
    candidates: [
      { kind: "fact", id: tea.id, content: "Minum teh pagi" },
      { kind: "commitment", id: doctor.id, content: "Belanja teh" },
    ],
  });
  assert.equal(memory.getFact(tea.id)?.status, "active");
  assert.equal(memory.listPendingCommitments(owner.id)[0]?.id, doctor.id);
});
