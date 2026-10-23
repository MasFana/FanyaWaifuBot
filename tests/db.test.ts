import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type Database from "better-sqlite3";
import { FrozenClock } from "../src/core/clock.js";
import { migrate, openDatabase } from "../src/db/index.js";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

test("migrates PRD schema once and provides FTS5 tables", () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  const clock = new FrozenClock(1_729_648_000_000);

  migrate(database, clock);
  migrate(database, clock);

  const facts = database
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'facts'")
    .get() as { n: number };
  const migration = database
    .prepare("SELECT version, applied_at FROM schema_migrations")
    .all() as Array<{ version: number; applied_at: number }>;
  const proactiveEvent = database
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'proactive_events'")
    .get() as { n: number };

  assert.equal(facts.n, 1);
  assert.equal(proactiveEvent.n, 1);
  assert.deepEqual(migration, [{ version: 1, applied_at: 1_729_648_000_000 }]);
  assert.doesNotThrow(() => database.prepare("INSERT INTO facts_fts(content) VALUES ('kopi')").run());
});

test("does not rerun an already applied schema version", () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)").run();

  migrate(database, new FrozenClock(1_729_648_000_000));

  const facts = database
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'facts'")
    .get() as { n: number };
  assert.equal(facts.n, 0);
});

test("opens every connection with foreign keys and WAL enabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "fanya-db-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "fanya.db"));
  databases.push(database);

  assert.equal((database.pragma("foreign_keys", { simple: true }) as number), 1);
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
});
