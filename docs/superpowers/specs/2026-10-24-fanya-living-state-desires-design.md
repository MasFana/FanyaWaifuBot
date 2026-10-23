# Fanya v3 — State Hidup & Keinginan (Living State & Desires) — Design

Tanggal: 2026-10-24
Status: draft — menunggu builder check, lalu persetujuan owner sebelum masuk plan.
Terkait: memperluas `2026-10-23-fanya-v2-anti-bot-design.md` (§6.2 mood, §6.4 bentuk & cadence) dan **mencabut** aturan bubble kaku yang sempat dibuat.

## 1. Intent & Why

Owner ingin Fanya bukan sekadar membalas pesan, tapi terasa **punya kehidupan, perasaan, dan keinginan sendiri** — bertindak sesuai konteks, bukan menurut aturan bentuk yang kaku.

Kejujuran dulu: ini **bukan** AGI/kesadaran nyata, dan tidak akan dibuat begitu. Yang dikejar adalah **kesan agensi**: lewat (a) konteks kaya, (b) state internal yang hidup dan benar-benar menyetir keputusan, (c) persona. Kode menjadi *pagar keselamatan*, bukan pengatur ekspresi. Prinsip: **model yang memutuskan nada/panjang/balas-diam dari konteks + state; kode hanya batas anti-flood & safety.**

Bukti masalah saat ini (dari DB `data/fanya.db` + audit kode):

- **Balas per pesan, bukan per giliran.** `TelegramChannel.receive` (`src/channels/telegram.ts:129`) memproses tiap update Telegram langsung. Owner kirim 4 pesan beruntun (`aku tadi makan pedes banget` / `kek` / `jir` / `ga masuk akal`) → dijawab 4 kali terpisah, konteks terpecah, beberapa jawaban nyaris duplikat. Ini akar utama keluhan "jadi aneh, tidak satu konteks".
- **Bentuk kaku melawan konteks.** `splitDynamicBubbles` (`telegram.ts:366`) + aturan persona "maksimum 3 balon, ~30% 1 balon". Percobaan memaksa *jumlah balon dari panjang pesan owner* (word-count budget) sudah **dicabut** karena salah arah: user minta penjelasan panjang dengan pesan pendek tetap harus boleh panjang.
- **State ada tapi mati.** `PersonaState` (affection, ngambekUntil, recentOpenings/Endings/Emojis) + `computeMood` (`src/core/mood.ts`) ada, tetapi `ngambekInfluenceEnabled = false` (`mood.ts:21`) → state tak pernah mengubah keputusan; hanya dirender sebagai cue pasif (`context.ts:43`).
- **Tak ada "dunia sendiri".** Semua perilaku reaktif terhadap chat; tak ada aktivitas/fokus yang berjalan sendiri, tak ada inisiatif yang benar-benar lahir dari keinginan internal.

## 2. Goals

- **Satu giliran = satu balasan.** Pesan owner yang beruntun digabung (debounce) → satu agent turn atas konteks utuh.
- **State hidup yang menyetir.** Energi, aktivitas/fokus, afeksi, ngambek/stance, dan *drives* (keinginan) dihitung & disimpan, lalu **mengubah** tone, panjang, keputusan balas/diam/tunda, dan inisiatif — bukan sekadar dihias.
- **Tiga momen fondasi benar-benar muncul** (lihat §6.4): (1) punya kehidupan sendiri, (2) friksi/batasan, (3) inisiatif.
- **Bentuk dikendalikan model.** Jumlah balon, panjang, dim/berhenti di tengah pikiran = keputusan model dari konteks + state. Kode hanya cap anti-flood + safety.
- **Dunia maju tanpa owner.** Saat owner diam, aktivitas/drives Fanya tetap berkembang, sehingga sapaan/proaktif berikutnya terasa lahir dari keinginan, bukan jadwal.

## 3. Non-Goals

- Kesadaran/sentience nyata; tidak ada self-modifying code, RL/fine-tuning, atau klaim batin.
- Dependency npm baru yang berat; generator tetap model `nemotron-3-ultra-550b-a55b` (`.env`).
- Mengubah alur media/download, memory facts/commitments, atau skema inbound dedup.
- Menghapus safety guardrails atau membuat persona klaim kesadaran nyata.

## 4. Anti-Goals (gagal walau teknis jalan)

- Terasa gimmick: delay/timer palsu yang justru bikin bot kelihatan rusak.
- Ngambek manipulatif/menghukum; owner merasa ditinggal atau dicuekin berlarut tanpa jalan kembali.
- Over-constrain → Fanya jadi kaku/dingin (mengulang kesalahan v2).
- Diam total pada DM langsung berlarut tanpa mekanisme "balik" & rekonsiliasi.
- Inisiatif jadi spam (nyapa/nyerocos terus).

## 5. Constraints & Keputusan (diputuskan owner)

- `C1` **Cabut bubble budget kaku** (word-count). Bentuk balon = keputusan model. Kode simpan **cap anti-flood** saja.
- `C2` **Turn aggregation**: gabung pesan beruntun owner (debounce) → satu balasan.
- `C3` **State menyetir keputusan** (tone, panjang, balas/diam/tunda, inisiatif, bantah/nolak), bukan kosmetik.
- `C4` **Tiga momen** jadi fondasi desain state: (1) kehidupan sendiri, (2) friksi/batasan, (3) inisiatif.
- `C5` Lanjutkan keputusan v2: ending boleh netral, afeksi dinamis, ngambek diaktifkan bertahap (log-only dulu), mood deterministik, persona de-anchored, turn task tanpa bullet/arrow.
- `C6` Safety/guardrails tetap; persona tidak mengklaim kesadaran nyata; friksi harus recoverable & non-manipulatif.

## 6. Rancangan

### 6.1 Turn Aggregation — "satu giliran"

Seam: `TelegramChannel.receive` (`telegram.ts:129`) + `OwnerQueue` (`src/core/owner-queue.ts`).

- Buffer teks inbound **per owner**. Tiap pesan baru mereset timer debounce (jendela `debounceMs`).
- Saat timer habis (owner berhenti mengetik sejenak), **flush**: gabungkan semua teks dalam burst menjadi satu inbound turn, lalu jalankan **satu** `agent.runInbound`.
- Penyimpanan: builder memutuskan apakah menyimpan tiap pesan owner terpisah (dan menggabung hanya untuk context) atau satu pesan gabungan. Rekomendasi: **simpan tiap pesan terpisah** (jejak asli) + kirim burst sebagai `inboundText` gabungan + `excludeMessageId` untuk semua id burst.
- **Command** (`/start`, `/memory`, dst.) meng-flush burst yang tertunda dulu, lalu diproses langsung (tidak menunggu debounce).
- **Proaktif/heartbeat** meng-flush burst owner dulu sebelum wakeup agar tidak tabrakan.
- **Indikator mengetik**: boleh kirim `sendChatAction("typing")` selama jendela/menunggu; tetap halus.
- **Kepemilikan buffer**: buffer + timer debounce hidup di `TelegramChannel` (pemilik `receive`); `Channel` mengekspos `flushPending(userId?)` yang dipanggil `HeartbeatEngine` sebelum wakeup (wiring `main.ts`). Lihat §10.4.
- Deferral ("nanti") berbeda dari debounce: lihat §6.4 momen 1.

### 6.2 Living State — state hidup (deterministik)

Perluas `PersonaState` → `LivingState` (nama final = call builder). Field inti:

- `energy` (rendah/sedang/hangat) — f(jam lokal), lanjut v2 `computeMood`.
- `activity` — apa yang Fanya sedang lakukan + sejak kapan (mis. "baca novel bab terakhir", "main game", "rebahan dengerin anisong"). Dipilih dari kumpulan aktivitas; punya durasi.
- `affection` (0–1) — sudah ada; decay pelan.
- `ngambekUntil` + `stance` — sudah ada; stance = boleh bantah/nolak (lihat §6.4 momen 2).
- `drives` — vektor keinginan (§6.3).
- `updatedAt`.

Simulasi/tick deterministik (tanpa LLM), dijalankan saat `context.build` **dan** saat heartbeat tick:

- Aktivitas maju/berakhir menurut waktu; saat selesai, Fanya bisa "kosong" → memicu inisiatif (momen 3).
- Energi mengikuti jam; drives tumbuh/decay; afeksi decay (v2).
- State **tetap maju walau owner diam** (dunia sendiri).

Persistensi: reuse `users.settings_json` (seam yang sudah dipakai `getPersonaState`/`setPersonaState`, `service.ts:347`). Bila perlu tabel sendiri = call builder.

### 6.3 Drives — keinginan (fondasi state)

Sekumpulan skalar (0–1) + aktivitas saat ini. Set awal (usulan; final = call builder):

- `wantCompany` — rindu vs asik sendiri. Naik saat lama sepi; turun saat asik.
- `wantToShare` — pengen pamer/cerita hal baru (chapter, temuan, mood).
- `focus` — seberapa "nanggung" & enggan diganggu oleh aktivitas sekarang.
- `boundary` — kesediaan bantah/nolak/ngambek (kekuatan karakter).
- `energy`, `affection` — dari §6.2.

Dinamika: naik/turun oleh waktu + hasil turn owner (mis. dipuji → `wantCompany` turun, `affection` naik; dicueki → `wantCompany` naik, `boundary` aktif). Drive dirender ke prompt sebagai cue bahasa manusia (bukan angka), lalu model memetakannya ke tindakan.

### 6.4 Decision Layer — tiga momen

**Momen 1 — Kehidupan sendiri (sibuk / fokus).**
`focus` + `activity` menentukan apakah Fanya (a) balas antusias, (b) balas singkat karena nanggung ("bentar, lagi seru nih bab terakhir"), atau (c) **tunda** dan balas nanti. Bukan diam permanen pada DM langsung: paling jauh *defer* dengan janji balik. Mekanisme tunda (jadwalkan via heartbeat/commitment) = call builder.

**Momen 2 — Friksi / batasan (bukan yes-man).**
Daftar kecil value/prinsip + `boundary` memungkinkan Fanya bantah, nolak permintaan, atau ngambek **konsisten** (tidak luluh hanya karena satu "maaf"). Rekonsiliasi punya syarat (waktu + repair beat tulus), tetap recoverable & non-manipulatif (`C6`). Deteksi konflik value = call builder.

**Momen 3 — Inisiatif / agenda sendiri.**
`wantToShare` / `wantCompany` + aktivitas yang baru selesai dapat memicu proaktif: nyapa duluan, pamer hal baru dibaca, atau **belokkan topik** saat obrolan membosankan. Tunduk pada rem yang ada: `quietHours`, `maxUnansweredProactive` (`heartbeat.ts:66`, `config.ts`). Topik-belok di tengah turn = keputusan model dari cue `wantToShare`. Trigger time-based lama (`spontaneous` via `spontaneousIdleHours`) **diganti** oleh drive; `greeting` tetap berjangkar waktu — keduanya berbagi satu gate rem. Lihat §10.1.

**Locus kendali (semua momen).** Tone, panjang, bentuk, dan bantah = **keputusan model** dari cue + konteks. Kode hanya menegakkan keputusan koarse yang butuh timer/state: **balas-now vs tunda** (`focus` tinggi) + cap anti-flood. Lihat §10.2.

### 6.5 Context / Prompt rendering

- Ganti baris statis `Suasana hati sekarang: <cue>` (`context.ts:43`) dengan cue `LivingState` + `drives` dalam bahasa natural (mis. `"lagi asik baca, agak males diganggu; kangen; pengen cerita chapter baru"`).
- **Hapus aturan bentuk kaku** di persona (jumlah balon tetap, persentase 1-balon, dsb.). Ganti dengan izin eksplisit: *"putuskan sendiri jumlah & panjang balon, boleh diam/singkat/tunda, boleh bantah"*.
- Pertahankan de-anchoring v2 (deskriptor tone, bukan teks).
- Opsional (call builder): model melaporkan balik drive yang ia pakai / usul perubahan state sebagai JSON kecil, yang divalidasi kode.

### 6.6 Guardrails & Safety

- Fanya tetap hangat secara keseluruhan; safety v2 (`harness/guardrails.md`) tetap.
- Friksi harus recoverable; tidak ada ngambek tak berujung atau pola manipulatif/coercive.
- Tidak mengklaim kesadaran nyata; jangan mengarang memori/tindakan eksternal.
- **Batas fiksi vs halusinasi** (§10.3): boleh mengklaim kehidupan & batin *sendiri* (fiksi karakter); dilarang mengklaim realitas bersama/owner atau tindakan eksternal di luar memory/tool.
- Cap anti-flood & biaya tetap ada di kode sebagai pagar, terlepas dari keputusan model.

### 6.7 Integrasi file & seam

- `src/channels/telegram.ts` `receive` — debounce/agregasi burst; flush untuk command & proaktif.
- `src/core/agent.ts` — satu turn atas konteks gabungan; jalur deferral.
- `src/core/context.ts` — render `LivingState` + drives; buang baris statis.
- `src/core/persona-state.ts` / `src/core/mood.ts` — perluas ke `LivingState` + tick deterministik.
- `src/memory/service.ts` — persist/baca state; burst storage.
- `src/core/heartbeat.ts` — tick dunia + pemicu inisiatif/deferral.
- `harness/persona.md` — cabut aturan bentuk kaku; tambah izin agency.
- `src/config.ts` — `debounceMs`, jendela/flag, cap anti-flood, (flag ngambek).

## 7. Prioritas (usulan)

1. **Turn aggregation** (bug nyata, ROI tertinggi; langsung membunuh balasan spam per pesan).
2. **Cabut aturan bentuk kaku** + izinkan model pilih bentuk (prompt-only).
3. **LivingState deterministik** (energi/aktivitas/fokus) + render cue.
4. **Drives + decision gating** (balas singkat vs tunda).
5. **Friksi/batasan** + ngambek konsisten (aktifkan bertahap; log-only dulu, lanjut C5).
6. **Inisiatif proaktif diperkaya** (share, topic-steer).

## 8. Yang diserahkan ke builder (call builder)

- Skema & lokasi persistensi `LivingState` (`settings_json` vs tabel baru).
- Set drive final, rentang nilai, dan kurva naik/decay tiap drive.
- Nilai jendela `debounceMs` + apakah kirim indikator mengetik; perilaku test-nya (seam waktu).
- Mekanisme deferral ("balas nanti") — scheduling via heartbeat/commitment, dan batas lama tunda.
- Representasi value/prinsip + cara deteksi konflik; bentuk refusal/disagreement.
- Cara model melaporkan balik drive/state (bila dipakai) + validasinya.
- Skema penyimpanan burst (per-pesan vs gabungan) dan `excludeMessageId` multi.
- Nilai **cap anti-flood** di kode (pengganti bubble budget kaku).
- Rem inisiatif (rate limit tambahan di luar `maxUnansweredProactive`).
- Aktivasi ngambek (`ngambekInfluenceEnabled`) & kalibrasi (lanjut v2 §6, log-only).

## 9. Verifikasi

- **Probe suite** (deterministik clock-injected di CI; live smoke manual opsional — tanpa recorded nemotron fixture, lihat §10.5):
  - Momen 1: owner chat saat Fanya "lagi asik" → balas singkat atau tunda, bukan ingat-ingat nanggung.
  - Momen 2: owner omong nyebelin → Fanya bantah/nolak/ngambek; "maaf" sekali tak langsung luluh.
  - Momen 3: owner diam lama → Fanya inisiatif (nyapa/pamer/belok topik) dalam rem yang ada.
  - Burst: 4 pesan beruntun → **satu** balasan atas konteks utuh.
- **Unit test**: agregasi burst → satu `runInbound`; tick `LivingState` deterministik (energi/aktivitas/drive) tanpa NaN; drive gate mempengaruhi keputusan; command mem-flush burst; cap anti-flood benar.
- **Gate**: `pnpm typecheck` bersih; 6 kegagalan test pre-existing (`acceptance:40,76,96`, `telegram-auth:95`, `telegram-commands:50,109`) tetap pre-existing, bukan regresi.
- Jalankan dengan bot distop bila menyentuh `data/fanya.db`.

## 10. Resolusi Builder Check (call builder)

Lima pertanyaan builder. Semua disettle di sini sebagai **call** — tak ada yang wajib owner, tapi poin 2 & 3 paling berdampak; owner boleh veto.

1. **Proaktif: trigger lama vs drives** — *call*: `greeting` tetap event berjangkar waktu (2x/hari). Trigger `spontaneous` berbasis `spontaneousIdleHours` **diganti** oleh drive `wantCompany`/`wantToShare` + aktivitas selesai (momen 3). Keduanya berbagi **satu gate rem** (`quietHours` + `maxUnansweredProactive`) → tidak dobel-api. `runSocial` (`heartbeat.ts:62`) dirombak sekitar drives; test greeting/spontaneous lama disesuaikan.

2. **Locus kendali: model vs gate kode** — *call*: **hybrid**. State dirender sebagai cue; **tone, panjang, bentuk, bantah = keputusan model** dari konteks. Kode hanya menegakkan keputusan **koarse biner** yang memang butuh timer/mekanisme: *balas sekarang vs tunda* (`focus` tinggi) dan **cap anti-flood**. Unit test menutup gate defer + cap, bukan tone. Alasan: model 550B terbukti mengabaikan aturan bentuk kaku (bukti v2), jadi cue-only untuk tone aman, tapi keputusan tunda butuh kode karena mengatur waktu.

3. **Batas fiksi vs halusinasi** — *call*: Fanya **boleh** mengklaim kehidupan solo & batin *sendiri* (aktivitas, perasaan, apa yang ia baca/tonton) — itu fiksi karakter. **Dilarang** mengklaim realitas bersama/owner (kejadian, janji, fakta owner) atau tindakan eksternal (mengunduh, mengirim pesan) kecuali berasal dari memory/tool nyata. `harness/guardrails.md` diperbarui dengan garis ini agar persona tak kontradiktif.

4. **Kepemilikan buffer burst & flush lintas-komponen** — *call*: buffer + timer debounce hidup di `TelegramChannel` (pemilik `receive`). `Channel` mengekspos `flushPending(userId?)`; `HeartbeatEngine` menerima hook `flush` (pola sama seperti `agent`) dan memanggilnya sebelum wakeup. Wiring di `main.ts`. Ini menjaga "tidak tabrakan" tanpa menyerialkan `OwnerQueue` dengan salah.

5. **Probe suite butuh model asli?** — *call*: **tidak** untuk CI. Probe = test deterministik dengan clock ter-inject (state/tick/agregasi/gate). Live smoke manual opsional (LLM nondeterministik + butuh kredensial). Tidak ada recorded nemotron fixture di CI; `tests/fixtures` saat ini hanya berisi tool JS.