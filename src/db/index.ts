import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Clock } from "../core/clock.js";

const schema = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
const imageContextSchema = readFileSync(fileURLToPath(new URL("./migrations/002-image-context.sql", import.meta.url)), "utf8");
const migrations = [schema, imageContextSchema];

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  return database;
}

export function migrate(database: Database.Database, clock: Clock): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  database.transaction(() => {
    for (const [index, migration] of migrations.entries()) {
      const version = index + 1;
      const applied = database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
        .get(version);
      if (applied !== undefined) continue;
      database.exec(migration);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, clock.now());
    }
  })();
}
