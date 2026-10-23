PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Profil Owner & Status Sosial/Proaktif
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Sayang',
  pet_name TEXT NOT NULL DEFAULT 'sayang',
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  quiet_hours_start TEXT NOT NULL DEFAULT '23:30',
  quiet_hours_end TEXT NOT NULL DEFAULT '06:30',
  current_mood TEXT,
  mood_updated_at INTEGER,
  unanswered_proactive_count INTEGER NOT NULL DEFAULT 0,
  last_user_message_at INTEGER,
  last_proactive_at INTEGER,
  settings_json TEXT,
  created_at INTEGER NOT NULL
);

-- Pemetaan Channel (Telegram ID -> User ID internal)
CREATE TABLE IF NOT EXISTS identities (
  channel TEXT NOT NULL,               -- 'telegram' | 'cli'
  external_id TEXT NOT NULL,           -- Telegram numeric user ID (sebagai string)
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_id)
);

-- Sesi Percakapan
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  summary TEXT,
  summary_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Riwayat Pesan
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,                  -- 'user' | 'assistant' | 'tool'
  is_proactive INTEGER NOT NULL DEFAULT 0, -- 1 jika Fanya yang chat duluan
  content TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);

-- Deduplikasi Update Telegram
CREATE TABLE IF NOT EXISTS inbound_events (
  channel TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (channel, external_message_id)
);

-- Lapis 1: Semantic Memory (Fakta tentang Owner)
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,               -- Kalimat mandiri: "Alergi makan udang"
  category TEXT NOT NULL,              -- preferensi|rutinitas|keluarga|pekerjaan|kesehatan|lainnya
  origin TEXT NOT NULL,                -- stated|inferred
  status TEXT NOT NULL DEFAULT 'active', -- active|replaced|deleted
  replaced_by TEXT,
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id, status);

-- Lapis 2: Episodic Memory Search (SQLite FTS5)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  category,
  fact_id UNINDEXED,
  tokenize = 'unicode61'
);

-- Lapis 3: Prospective Memory (Jadwal, Pengingat & Follow-up)
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,                 -- "Sidang Proposal / Meeting Klien"
  context_notes TEXT NOT NULL,         -- "Sempat bilang deg-degan karena belum latihan"
  event_at INTEGER,                    -- Waktu acara berlangsung (epoch ms)
  remind_at INTEGER,                   -- Waktu Fanya harus chat sebelum acara
  reminded_at INTEGER,                 -- Terisi saat pengingat sudah dikirim
  follow_up_at INTEGER,                -- Waktu Fanya harus tanya kabar setelah acara
  followed_up_at INTEGER,              -- Terisi saat follow-up sudah dikirim
  status TEXT NOT NULL DEFAULT 'pending', -- pending|completed|cancelled
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(user_id, status, remind_at, follow_up_at);

CREATE TABLE IF NOT EXISTS proactive_events (
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  local_date TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, local_date)
);

-- Observabilitas & Audit Run
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,          -- 'inbound' | 'agenda_reminder' | 'agenda_followup' | 'spontaneous'
  harness_commit TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  usage_json TEXT,
  error_json TEXT
);

CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
