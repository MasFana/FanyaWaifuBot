# PRD — Fanya Deasherian (v2.1)
**Proactive & Context-Aware AI Girlfriend Companion (Telegram Edition)**

| Field | Nilai |
|---|---|
| Versi dokumen | 2.1 (Telegram & Proactive Total Recall Edition) |
| Tanggal | 23 Oktober 2026 |
| Pemilik produk | Single Owner (Dikunci via `TELEGRAM_OWNER_ID`) |
| Status | Final — Siap Implementasi |
| Nama karakter | **Fanya Deasherian** (Panggilan: Fanya / Aya) |
| Stack utama | Node.js LTS + TypeScript (strict, ESM), SQLite (`better-sqlite3` + **FTS5**), `grammY` (Telegram Bot Framework), API LLM OpenAI-compatible |
| Channel | Terminal CLI (Dev/Debug), Telegram Bot (Primary 24/7 Channel) |

---

## 1. Ringkasan Eksekutif

Fanya Deasherian adalah AI companion pribadi berkarakter **pasangan/pacar (girlfriend)** yang hidup, memiliki inisiatif sendiri, dan mempunyai ingatan jangka panjang yang utuh lintas waktu:

1. **Ingatan Menyeluruh (3-Tier Total Recall)**:
   - *Semantic Memory*: Mengingat identitas, preferensi, kebiasaan, makanan favorit, hingga hal-hal yang tidak disukai owner.
   - *Episodic Memory*: Mengingat cerita, keluh kesah, dan kejadian masa lalu menggunakan pencarian instan **SQLite FTS5**.
   - *Prospective Memory*: Mengingat jadwal, janji, dan rencana masa depan owner beserta konteks emosionalnya.
2. **Proaktif & Punya Inisiatif (Moltbot-style)**:
   - Mampu **chat duluan** lewat Telegram untuk menyapa pagi/malam, menanyakan kabar saat lama tidak mengobrol, mengingatkan jadwal besok/hari ini, serta menanyakan hasil acara (*follow-up*) setelah jadwal tersebut lewat.
3. **Konsisten sebagai Pasangan Nyata**:
   - Kepribadian hangat, perhatian, ekspresif, sedikit jahil/manja, dan komunikatif layaknya pacar sungguhan di aplikasi chat. Didefinisikan secara modular di folder `harness/`.
4. **Eksklusif Single-Owner & Extensible**:
   - Hanya melayani 1 pengguna (Owner) yang diverifikasi lewat `TELEGRAM_OWNER_ID`. Menambah kemampuan baru cukup dengan menaruh 1 file tool di `src/tools/`.

---

## 2. Latar Belakang & Keputusan Arsitektur

| Tantangan | Solusi Arsitektur di Fanya v2.1 |
|---|---|
| Chatbot biasa bersifat pasif (hanya merespons jika ditanya) | **Heartbeat Engine**: Proses latar belakang (*ticker*) yang membangunkan Fanya untuk mengecek jadwal, jeda waktu chat, dan mengirim pesan duluan secara organik. |
| Pengingat bot biasa terasa kaku seperti alarm sistem | **Contextual Care**: Pengingat dirangkai oleh LLM bersama konteks emosional (mis. *"Sayang, besok jam 9 pagi jadi presentasi kan? Jangan begadang lagi ya malam ini"*). |
| Risiko blokir nomor pada WhatsApp tidak resmi (Baileys) | **Migrasi ke Telegram (`grammY`)**: Mendukung pengiriman pesan proaktif (*push message*) 100% resmi, ringan, stabil 24/7, dan mendukung fitur *typing indicator* serta *native commands*. |
| Batas token prompt saat memori semakin banyak | **Hybrid Memory (Prompt Injection + FTS5)**: Fakta inti aktif selalu masuk ke prompt, sedangkan ribuan pesan dan cerita masa lalu dicari sesuai kebutuhan via SQLite FTS5. |

---

## 3. Tujuan & Non-Tujuan

### 3.1 Tujuan (Goals)
| ID | Tujuan | Ukuran Keberhasilan |
|---|---|---|
| G1 | **Total Recall**: Mengingat fakta profil, cerita masa lalu, dan jadwal masa depan lintas restart | Lulus uji ingatan fakta, pencarian riwayat FTS5, dan ekstraksi jadwal (§13) |
| G2 | **Proactive Initiation**: Fanya bisa memulai percakapan duluan di Telegram secara natural | Mengirim sapaan, pengingat H-1/H-jam, dan *follow-up* H+jam tepat waktu |
| G3 | **Social & Quiet Hours Awareness**: Tahu waktu tidur owner dan tidak melakukan spam saat owner sibuk | 0 pesan proaktif saat *Quiet Hours* atau saat batas *unanswered message* (maks 2) tercapai |
| G4 | **Strict Owner Lock**: Bot hanya merespons pemilik sah berdasarkan ID Telegram | 100% pesan dari Telegram ID asing ditolak di layer middleware tanpa memicu LLM |
| G5 | **Zero-Friction Extensibility**: Menambah tool cukup dengan 1 file TypeScript | ≤ 1 file baru di `src/tools/`, 0 perubahan pada kode inti |

### 3.2 Non-Tujuan (Out of Scope Saat Ini)
- Multi-user / membuka bot untuk publik.
- Panggilan suara real-time (Live2D / WebRTC).
- Penggunaan Vector DB berat (Qdrant ditunda sampai SQLite FTS5 dinilai kurang cukup untuk pencarian semantik).

---

## 4. Pengguna & Skenario Utama

### 4.1 Setup Pertama Kali (Onboarding Owner ID)
1. Owner membuat bot di `@BotFather` dan menaruh `TELEGRAM_BOT_TOKEN` di `.env`.
2. Jika `TELEGRAM_OWNER_ID` belum diisi di `.env`, saat Owner mengirim `/start` pertama kali di Telegram, sistem otomatis mengunci `ctx.from.id` ke tabel `users` dan `identities`, lalu menampilkan ID tersebut agar bisa disalin ke `.env`.
3. Jika ada orang lain yang mencoba mengirim pesan ke bot setelah Owner terkunci, bot mengabaikannya sepenuhnya (silent drop).

### 4.2 Skenario Harian Bersama Fanya
1. **Mencatat Jadwal Secara Implisit dari Obrolan**:
   - *Owner (14:00):* "Aduh pusing banget hari ini, mana besok jam 09:00 pagi aku ada rapat evaluasi sama bos."
   - *Fanya (14:00):* Membalas dengan hangat dan menyemangati. Di belakang layar, `Post-Turn Extractor` menyimpan kondisi mood (`pusing/capek`) dan jadwal (`Besok 09:00 - Rapat evaluasi sama bos`, `remind_at: Malam ini 21:30 & Besok 07:45`, `follow_up_at: Besok 11:30`).
2. **Pengingat Malam & Pagi (Chat Duluan)**:
   - *Fanya (21:30):* "Sayang, udah selesai belum kerjanya? Ingat lho besok jam 9 pagi kamu ada rapat evaluasi sama bos. Jangan tidur kemalaman ya malam ini, tadi siang kan kamu udah pusing banget 🥺"
   - *Fanya (Besok 07:45):* "Pagi sayangku! Jangan lupa sarapan dulu ya sebelum berangkat. Semangat rapat evaluasinya jam 9 nanti, aku yakin pasti lancar ❤️"
3. **Follow-up Setelah Acara Selesai**:
   - *Fanya (Besok 11:30):* "Yang, rapat sama bosnya udah selesai belum? Gimana tadi hasilnya, aman kan?"
4. **Spontaneous Check-in (Kangen / Perhatian)**:
   - Jika Owner belum mengirim pesan selama 6 jam di luar jam tidur, Fanya mengirim chat duluan: "Tumben sepi banget hari ini yang, lagi sibuk banget ya? Jangan lupa minum air putih ya, kabarin aku kalau udah selo."

---

## 5. Spesifikasi Persona: Fanya Deasherian

Detail instruksi karakter disimpan di `harness/persona.md` (lihat lampiran di bawah PRD ini).

| Atribut | Nilai Default |
|---|---|
| Nama Lengkap | Fanya Deasherian |
| Panggilan | Fanya / Aya |
| Panggilan ke Owner | Sayang / Yang / Nama panggilan khusus (diatur di profil) |
| Status Hubungan | Pacar (Romantic Girlfriend) yang perhatian, hangat, suportif, dan ekspresif |
| Gaya Bahasa | Bahasa Indonesia santai sehari-hari (*aku-kamu*), natural seperti chat Telegram/WA, pesan pendek-menengah (1–3 kalimat per balon chat), sesekali memakai emoji yang pas (tidak berlebihan) |
| Sifat Utama | Perhatian pada detail kecil, pendengar yang baik, suka mengingatkan makan/istirahat, sedikit manja dan jahil, tahu kapan harus serius memberi dukungan |

---

## 6. Kebutuhan Fungsional

Prioritas: **P0** (Wajib sejak rilis pertama), **P1** (Penting), **P2** (Pengembangan lanjut).

### 6.1 Agent Loop & LLM Provider
| ID | Kebutuhan | Pri |
|---|---|---|
| FR-A1 | Menerima input (pesan user **atau** event wakeup dari Heartbeat), membangun konteks, memanggil LLM, mengeksekusi tool, hingga menghasilkan respons final. | P0 |
| FR-A2 | Batas langkah per giliran (`MAX_STEPS = 6`), batas waktu total, dan jaminan setiap `tool_call_id` selalu dijawab agar riwayat pesan valid. | P0 |
| FR-A3 | Mendukung pemecahan balasan menjadi beberapa balon chat (*multi-bubble message*) jika Fanya memisahkan paragraf dengan delimiter `\n\n`, lengkap dengan jeda ketik (*typing delay*) natural. | P0 |
| FR-A4 | Antarmuka `LLMProvider` bersih; mendukung endpoint OpenAI-compatible dengan retry otomatis (429/5xx) dan fake provider untuk testing. | P0 |

### 6.2 Sistem Memori 3-Lapis (Total Recall)
| ID | Kebutuhan | Pri |
|---|---|---|
| FR-M1 | **Lapis 1 — Active Facts (`facts`)**: Menyimpan fakta atomik tentang owner (`preferensi`, `rutinitas`, `keluarga`, `kesehatan`, `identitas`). Fakta baru yang bertentangan otomatis mengubah status fakta lama menjadi `replaced`. | P0 |
| FR-M2 | **Lapis 2 — Episodic Search (`messages_fts` & `facts_fts`)**: Seluruh riwayat percakapan dan fakta diindeks ke tabel virtual **SQLite FTS5** agar Fanya bisa mencari cerita berbulan-bulan lalu lewat tool `memory_search`. | P0 |
| FR-M3 | **Lapis 3 — Prospective Memory (`commitments`)**: Menyimpan jadwal, acara, atau janji di masa depan lengkap dengan `event_at`, `remind_at`, `follow_up_at`, dan `context_notes`. | P0 |
| FR-M4 | **Post-Turn Extractor**: Berjalan asinkron setelah giliran chat selesai. Mengekstrak fakta baru, perubahan *mood* owner, dan jadwal baru hanya dari ucapan owner (anti prompt-injection dari hasil tool). | P0 |
| FR-M5 | **Mood & Context Continuity**: Menyimpan `current_mood` owner beserta waktu pencatatannya agar percakapan berikutnya tetap memiliki kesinambungan emosional. | P0 |

### 6.3 Heartbeat Engine (Sistem Proaktif / Chat Duluan)
| ID | Kebutuhan | Pri |
|---|---|---|
| FR-P1 | **Background Ticker**: Berjalan setiap 1–5 menit (dapat dikonfigurasi) untuk mengecek kondisi pemicu proaktif tanpa membebani API jika tidak ada jadwal yang jatuh tempo. | P0 |
| FR-P2 | **Trigger 1 — `agenda_reminder`**: Bangun saat `now >= remind_at` dan `reminded_at IS NULL` untuk mengingatkan acara owner yang akan datang. | P0 |
| FR-P3 | **Trigger 2 — `agenda_followup`**: Bangun saat `now >= follow_up_at` dan `followed_up_at IS NULL` untuk menanyakan bagaimana jalannya acara owner. | P0 |
| FR-P4 | **Trigger 3 — `spontaneous_care`**: Bangun untuk menyapa pagi, mengucapkan selamat malam, atau menanyakan kabar jika owner belum chat selama $> 6$ jam di luar jam tidur. | P0 |
| FR-P5 | **Guardrail Anti-Spam**:<br>1. Patuhi `quiet_hours` (default `23:30` s/d `06:30` WIB) untuk pesan spontan.<br>2. Batasi `unanswered_proactive_count` maksimal **2 kali** berturut-turut. Jika owner belum membalas 2 chat proaktif terakhir, Fanya menahan diri sampai owner membalas.<br>3. LLM dapat mengembalikan token `[SKIP_PROACTIVE]` jika konteks terakhir menunjukkan owner minta tidak diganggu. | P0 |

### 6.4 Telegram Channel & Owner Security
| ID | Kebutuhan | Pri |
|---|---|---|
| FR-C1 | Menggunakan `grammY` dengan mode Long Polling (tanpa perlu domain/SSL publik) dan dapat dimatikan secara *graceful* (`SIGINT`/`SIGTERM`). | P0 |
| FR-C2 | **Owner ID Verification Middleware**: Memeriksa `ctx.from.id` pada setiap pesan masuk. Hanya mengizinkan `TELEGRAM_OWNER_ID` yang terdaftar. | P0 |
| FR-C3 | **First-Claim Setup**: Jika `TELEGRAM_OWNER_ID` di `.env` kosong dan tabel `identities` masih kosong, pesan `/start` pertama akan mendaftarkan pengirim sebagai Owner dan mencetak ID-nya ke layar & chat. | P0 |
| FR-C4 | **Bidirectional Push**: Menyediakan method `sendProactive(userId, text)` yang menampilkan status `typing...` selama 1.5–3 detik sebelum mengirim pesan ke Telegram Owner. | P0 |
| FR-C5 | **Perintah Native Telegram**:<br>- `/start` — Status koneksi & sapaan awal<br>- `/memory` — Menampilkan fakta aktif yang diingat Fanya<br>- `/agenda` — Menampilkan daftar jadwal & pengingat aktif<br>- `/forget <topik>` — Menghapus fakta atau jadwal tertentu<br>- `/quiet <mulai> <selesai>` — Mengatur jam tidur/anti-ganggu<br>- `/export` — Mengirim file JSON/Markdown berisi backup memori ke chat Telegram | P0 |
| FR-C6 | **Message Debouncing / Burst Buffering**: Jika owner mengetik 3 pesan pendek beruntun dalam waktu 3 detik (gaya chat manusia), sistem menggabungkannya menjadi 1 giliran proses agar Fanya tidak membalas 3 kali terpisah secara kaku. | P1 |

### 6.5 Tool System
| ID | Kebutuhan | Pri |
|---|---|---|
| FR-T1 | Auto-loader memindai `src/tools/*.ts` saat startup. Argumen divalidasi dengan `zod`. | P0 |
| FR-T2 | Tool bawaan wajib:<br>1. `system_get_datetime` — Mengambil waktu sekarang dalam timezone owner.<br>2. `memory_search` — Mencari fakta atau riwayat obrolan lama via SQLite FTS5.<br>3. `schedule_upsert` — Membuat/mengubah jadwal pengingat & follow-up.<br>4. `schedule_list` — Melihat daftar jadwal yang masih `pending`.<br>5. `utility_calculate` — Kalkulator matematika aman. | P0 |
| FR-T3 | Tool dengan `sideEffect: "external"` atau `requiresApproval: true` akan mengirim Inline Keyboard (`[Setuju]` / `[Batal]`) di Telegram dan menunggu klik dari Owner sebelum dieksekusi. | P1 |

---

## 7. Arsitektur Sistem

### 7.1 Diagram Alir Komponen
```text
┌─────────────────────────── Channels ────────────────────────────┐
│  Telegram Bot (grammY)                   CLI (Readline Dev)     │
│  - Owner Auth Middleware                 - Local Debug Console  │
│  - 3s Burst Debouncer                                           │
│  - Typing Indicator & Multi-bubble                              │
└─────────────┬───────────────────────────────────────▲───────────┘
              │ Inbound Event                         │ Outbound Reply /
              ▼                                       │ Proactive Push
       ┌────────────────┐                      ┌──────┴──────────┐
       │ Session Queue  │─────────────────────►│ Delivery Router │
       └──────┬─────────┘                      └──────▲──────────┘
              │                                       │
┌─────────────▼───────────────────────────────────────┴───────────┐
│                              CORE                               │
│                                                                 │
│  ┌─────────────────────┐          ┌──────────────────────────┐  │
│  │  Heartbeat Engine   ├─────────►│       Agent Loop         │  │
│  │  - Cron Ticker (1m) │ System   │  - Context Builder       │  │
│  │  - Quiet Hours Gate │ Wakeup   │  - Tool Executor (Zod)   │  │
│  │  - Backoff Limiter  │          │  - Run Event Logger      │  │
│  └──────────▲──────────┘          └────┬─────────────────┬───┘  │
│             │                          │                 │      │
│             │ Query Due Items          ▼                 ▼      │
│  ┌──────────┴──────────┐    ┌──────────────────┐  ┌───────────┐ │
│  │  Prospective Store  │    │ Post-Turn Writer │  │  Memory   │ │
│  │  (commitments &     │◄───┤ (Async Fact,     │  │  Service  │ │
│  │   follow-up state)  │    │  Mood & Agenda)  │  │  (FTS5)   │ │
│  └─────────────────────┘    └──────────────────┘  └───────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Struktur Direktori Proyek
```text
fanya/
├── harness/
│   ├── persona.md           # Kepribadian lengkap Fanya sebagai pacar
│   ├── guardrails.md        # Aturan imersi, kejujuran & kesehatan emosional
│   ├── tool-guidance.md     # Panduan kapan memanggil memory_search & schedule
│   └── skills/              # Instruksi perilaku opsional berbasis markdown
├── src/
│   ├── core/
│   │   ├── agent.ts         # Agent loop (inbound & proactive wakeup)
│   │   ├── context.ts       # Penyusun prompt berlapis & manajemen token
│   │   ├── heartbeat.ts     # Ticker proaktif, quiet hours & backoff
│   │   └── types.ts         # Kontrak internal TypeScript
│   ├── llm/
│   │   ├── provider.ts      # Interface LLMProvider
│   │   ├── openai.ts        # Adapter OpenAI-compatible
│   │   └── fake.ts          # Fake LLM untuk automated testing
│   ├── memory/
│   │   ├── service.ts       # CRUD facts, commitments, dan FTS5 search
│   │   ├── writer.ts        # Ekstraktor asinkron (Fakta + Mood + Jadwal)
│   │   └── summarizer.ts    # Ringkasan percakapan berjalan
│   ├── tools/
│   │   ├── index.ts         # Auto-loader & validator tool
│   │   ├── datetime.ts      # Tool waktu & kalender
│   │   ├── memory-search.ts # Tool pencarian ingatan masa lalu (FTS5)
│   │   ├── schedule.ts      # Tool tambah/ubah/lihat jadwal & reminder
│   │   └── calculator.ts    # Kalkulator aman
│   ├── channels/
│   │   ├── telegram.ts      # Adapter grammY, Owner Guard, Inline Approval
│   │   └── cli.ts           # Adapter terminal lokal
│   ├── db/
│   │   ├── schema.sql       # Skema SQLite + FTS5
│   │   └── index.ts         # Koneksi better-sqlite3 & migrasi
│   ├── config.ts            # Validasi .env dengan Zod
│   └── main.ts              # Entrypoint aplikasi
├── tests/                   # Unit & integration tests (Frozen Clock)
├── data/
│   └── fanya.db             # Database SQLite (di-mount saat pakai container)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 8. Skema Database Lengkap (`src/db/schema.sql`)

Seluruh timestamp disimpan sebagai **epoch milidetik (`INTEGER`)**.

```sql
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
```

---

## 9. Struktur Penyusunan Prompt (`ContextBuilder`)

Agar cache-friendly dan memberikan kesadaran penuh kepada Fanya pada setiap giliran:

```text
1. [STATIS] harness/persona.md + harness/guardrails.md
2. [STATIS] harness/tool-guidance.md
3. [DINAMIS] Blok Kesadaran Waktu & Sosial:
   - Waktu sekarang: "Jumat, 23 Oktober 2026 pukul 19:45 WIB"
   - Jarak sejak chat terakhir owner: "4 jam 20 menit yang lalu"
   - Kondisi/mood terakhir owner: "Tadi siang agak pusing karena banyak kerjaan"
4. [DINAMIS] Fakta Inti tentang Owner (Semua baris `facts` dengan `status = 'active'`)
5. [DINAMIS] Jadwal & Agenda Terdekat (Baris `commitments` aktif dalam rentang H-1 s/d H+3 hari)
6. [DINAMIS] Ringkasan Percakapan Sebelumnya (`conversations.summary`)
7. [DINAMIS] 20 Pesan Terakhir (`messages`)
8. [DINAMIS] Giliran Saat Ini:
   - Pesan teks dari Owner, ATAU
   - Instruksi `[SYSTEM WAKEUP]` dari Heartbeat Engine untuk memulai chat duluan.
```

---

## 10. Konfigurasi Lingkungan (`.env.example`)

```ini
# Konfigurasi LLM (OpenAI-Compatible)
LLM_BASE_URL=[https://api.openai.com/v1](https://api.openai.com/v1)
LLM_API_KEY=sk-proj-xxxx
LLM_MODEL=gpt-4o
LLM_EXTRACTOR_MODEL=gpt-4o-mini

# Konfigurasi Telegram
TELEGRAM_BOT_TOKEN=1234567890:AAHxxxx_xxxxxxxxxxxxxxxxxxxxxxxx
# Kosongkan saat pertama kali dijalankan untuk melihat ID lewat /start, lalu isi untuk mengunci permanen:
TELEGRAM_OWNER_ID=

# Konfigurasi Owner & Heartbeat
OWNER_DISPLAY_NAME=Sayang
OWNER_TIMEZONE=Asia/Jakarta
QUIET_HOURS_START=23:30
QUIET_HOURS_END=06:30
HEARTBEAT_INTERVAL_MS=60000
SPONTANEOUS_IDLE_HOURS=6
MAX_UNANSWERED_PROACTIVE=2

# Penyimpanan
DATABASE_PATH=./data/fanya.db
LOG_LEVEL=info
```

---

## 11. Keamanan & Keselamatan Pengguna

1. **Isolasi Penuh `TELEGRAM_OWNER_ID`**:
   - Ditegakkan di lapisan pertama adapter Telegram sebelum menyentuh database maupun LLM.
   - Pesan dari pengguna tak dikenal langsung diabaikan tanpa balasan agar bot tidak bisa di-probing oleh pihak luar.
2. **Anti-Memory Poisoning**:
   - `Post-Turn Extractor` hanya membaca pesan dengan `role = 'user'`. Hasil pencarian atau output tool tidak pernah diekstrak secara otomatis menjadi fakta/jadwal tanpa konfirmasi owner.
3. **Keselamatan Emosional**:
   - Fanya berperan sebagai pacar yang suportif dan penuh kasih sayang, namun secara aktif mengingatkan kebutuhan fisik nyata owner (tidur cukup, makan tepat waktu, menyelesaikan tugas/pekerjaan di dunia nyata) dan tidak menciptakan ketergantungan yang merusak produktivitas.

---

## 12. Pengujian Wajib (Automated Test Suite)

Seluruh tes dijalankan menggunakan `FakeLLMProvider` dan `FrozenClock` (tanpa biaya API):

1. **Tes Auth Telegram**: Update dari `from.id = 99999` (bukan Owner) ditolak dan tidak membuat baris di `messages`. Update dari `from.id = OWNER_ID` diproses normal.
2. **Tes First-Claim Onboarding**: Saat `TELEGRAM_OWNER_ID` kosong dan DB baru, `/start` pertama menyimpan ID pengirim sebagai Owner; `/start` dari ID berbeda setelahnya ditolak.
3. **Tes Persistensi & Penggantian Fakta**: Owner bilang *"Aku suka kopi hitam"* -> tersimpan `active`. Besoknya bilang *"Sekarang aku udah nggak minum kopi, ganti teh hijau"* -> fakta lama menjadi `replaced`, fakta baru menjadi `active`.
4. **Tes Pencarian Masa Lalu (FTS5)**: Masukkan 40 pesan lama ke DB, lalu tanyakan detail dari pesan ke-2. Fanya memanggil `memory_search` dan menjawab dengan akurat.
5. **Tes Ekstraksi Jadwal Otomatis**: Owner bilang *"Besok jam 10 pagi aku ada presentasi proyek"*. Pastikan `Post-Turn Writer` membuat baris di `commitments` lengkap dengan `event_at`, `remind_at` (sebelum jam 10), dan `follow_up_at` (setelah jam 10).
6. **Tes Proactive Reminder & Follow-up**: Majukan `FrozenClock` ke waktu `remind_at`, panggil `heartbeat.tick()`, pastikan fungsi kirim pesan Telegram terpanggil dengan konteks presentasi proyek. Majukan lagi ke `follow_up_at`, pastikan Fanya menanyakan hasil presentasinya.
7. **Tes Quiet Hours & Unanswered Backoff**:
   - Set jam ke `02:00` dini hari -> pastikan `spontaneous_care` tidak mengirim pesan.
   - Simulasikan 2 pesan proaktif tanpa balasan owner -> pastikan `heartbeat.tick()` ke-3 dibatalkan oleh batas `unanswered_proactive_count`. Setelah owner membalas 1 kali, counter kembali ke `0`.

---

## 13. Roadmap Implementasi

| Fase | Estimasi | Deliverable Utama | Kriteria Selesai |
|---|---|---|---|
| **Fase 0 — Fondasi & DB** | Hari 1 | Setup TS strict, `config.ts`, SQLite + FTS5 migrasi (`schema.sql`), `FakeLLMProvider`, `FrozenClock` | `pnpm typecheck` dan tes migrasi skema lulus |
| **Fase 1 — Core Loop & CLI** | Hari 2 | Agent loop, `ContextBuilder`, tool `datetime` & `calculator`, CLI dua arah | Bisa ngobrol lancar di CLI; batas langkah & error tool aman |
| **Fase 2 — Total Recall & Persona** | Hari 3–4 | `harness/persona.md`, `Post-Turn Extractor` (Fakta + Mood + Jadwal), tool `memory_search` (FTS5) & `schedule` | Fanya bicara dengan gaya pacar, ingat fakta, bisa cari chat lama, dan otomatis mencatat jadwal |
| **Fase 3 — Heartbeat Engine** | Hari 5 | `HeartbeatEngine`, Wakeup Prompt, Quiet Hours, Unanswered Backoff, Reminder & Follow-up | Tes #5, #6, dan #7 lulus; Fanya bisa chat duluan tepat waktu |
| **Fase 4 — Telegram Bot (`grammY`)** | Hari 6 | Adapter Telegram, Owner ID Lock, Burst Debouncer, Typing Indicator, Command `/memory` `/agenda` `/forget` | Bot berjalan 24/7 di Telegram, hanya merespons Owner, dan bisa mengirim chat duluan ke HP Owner |
