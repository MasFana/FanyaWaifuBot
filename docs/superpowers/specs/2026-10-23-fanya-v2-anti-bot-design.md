# Fanya v2 — Anti-Bot Rework (Design)

Tanggal: 2026-10-23
Status: disetujui owner, siap masuk plan.

## 1. Intent & Why

Fanya (bot Telegram companion di repo `fanya-telegram`) terasa "kayak bot" walau persona.md sudah ditulis detail. Owner ingin Fanya terasa seperti manusia yang benar-benar nge-chat: bervariasi, punya mood, punya hidup, kadang dingin, kadang manja.

Akar masalah (terukur, dari analisis DB + audit prompt):

- **Anchoring contoh verbatim.** persona.md memuat ~15 kalimat contoh ditulis sebagai string kutipan (`pagiiiii sayaaaaang...` line 119, `asdfghjkl` line 14, dialog line 76–94). Model kecil/menengah menyalinnya sebagai *continuation*, bukan tone. Bukti: balasan seq5 ≈ line 119 near-verbatim.
- **Rule-dump surface marker tanpa counterweight.** ~130 baris aturan hampir semua mengatur marker permukaan (lowercase, tanpa titik, elongation, emoji, pet-name). Model memaksimalkan **semua** marker tiap pesan → karikatur "checklist human". Tak ada aturan "kadang jangan / kadang netral".
- **Monoton.** `users.current_mood` ada (`src/db/schema.sql:17`) tapi selalu `null` — ekstraktor (`src/memory/writer.ts:43`) tak pernah mengisi. Dynamic block (`src/core/context.ts:37-44`) deterministik → register tak berubah turn-to-turn.
- **Tell terukur:** 12/12 balasan berakhir manis (`🥺`/`><`/`🤍`), 0 netral; bubble mode 3 (50%); tak pernah ada balasan pendek (<87 char); palette emoji didaur ulang (🥺😭🤍 = 24/31).
- **Leak token internal.** `[SYSTEM WAKEUP]` + `Trigger: ...` + `greetingInstruction` disuntik ke user-turn (`src/core/context.ts:46`, `src/core/agent.ts:39`) tanpa dibersihkan → model kadang mengutip "greeting wakeup".

## 2. Goals

- Fanya terdengar manusia: panjang, jumlah bubble, ending, dan energi **bervariasi** tiap turn.
- Punya **state emosi** (energy, missYou, affection, ngambek) yang dihitung kode, bukan dikarang LLM, dan decay/bangkit realistis.
- Contoh di persona jadi **deskriptor tone**, bukan teks yang bisa disalin.
- Turn task (gagal download dsb.) tetap bersuara Fanya, tanpa registrasi helpdesk (bullet/arrow).
- Guard anti-pengulangan: opening/ending/emoji yang baru dipakai tak muncul lagi.

## 3. Non-Goals

- Tak mengubah arsitektur memory inti (facts/commitments/summary tetap).
- Tak menambah dependency npm baru.
- Tak mengubah mekanisme pengiriman media/download.
- Tak mengubah skema ke DB state engine penuh (Group 8 penuh) — hanya slice yang dibutuhkan Group 2/3.

## 4. Anti-Goals (gagal walau teknis jalan)

- Fanya jadi dingin/kaku karena over-constrain.
- Ngambek terasa menghukum / manipulatif.
- Delay/"life" palsu terasa gimmicky atau bikin bot keliatan rusak.
- Perubahan bikin owner tak lagi merasa disayang (owner ingin manja, tapi tak monoton).

## 5. Constraints & Keputusan (diputuskan owner)

- `C1` Ending boleh **tidak** manis — kadang netral, kadang berhenti di tengah pikiran. (owner: oke)
- `C2` Afeksi **dinamis**: cuek / diam lama bikin Fanya bisa ngambek lalu luluh. (owner: iya)
- `C3` Kalibrasi ngambek = **call builder** (rekomendasi owner: dingin ringan, auto-luluh ≤ ~5 jam atau lebih cepat kalau owner nyapa manis). Owner setuju "sarankan yang terbaik".
- `C4` Mood = **deterministik dihitung kode** (owner menyerahkan). LLM hanya memilih dari cue yang disediakan.
- `C5` Persona direwrite: buang semua string kutipan verbatim, ganti deskriptor.
- `C6` Turn task tetap suara Fanya, tanpa bullet/arrow.

**Model produksi (selesai, dari `.env`):** `nvidia/nvidia/nemotron-3-ultra-550b-a55b` (550B MoE, ~55B aktif) untuk generator & extractor. Kelas besar → plan tetap prompt+kode, tanpa track evaluasi/seleksi model.

Catatan penting: leak anchoring (seq5 ≈ line 119) **terjadi pada model 550B ini**. Artinya menyalin contoh verbatim bukan cuma masalah model kecil — G1 tetap wajib, malah lebih krusial.

## 6. Rancangan

### 6.1 Persona (statis) — `harness/persona.md` rewrite

- Buang semua string kutipan first-person. Ganti deskriptor tone, contoh: bukan `` `pagiiiii sayaaaaang...` `` tapi `[pembuka: sapaan pagi ngantuk, 1–4 kata, lowercase, boleh trail-off; JANGAN salin kata]`.
- Jika perlu contoh, isi sengaja salah topik + tag `(tone only, jangan pakai teksnya)`. Dialog situasional line 76–94 dipindah ke `harness/tone-examples.md` sebagai **bentuk**, bukan konten.
- Tambah **aturan bentuk**: ~30% 1 bubble pendek; ~10% 1 kata/emoji-only/`...`; max 3 bubble. Ending netral jadi modal; manis ~20%.
- Marker (lowercase, tanpa titik, elongation, emoji) jadi **opsional per-mood**, bukan wajib.
- Tambah **aturan turn task**: tetap suara Fanya, dilarang bullet `-`/`•` dan arrow `->` di semua turn (bukan cuma `/memory` `/agenda` seperti line 102 sekarang).

### 6.2 State emosi (DB + kode) — deterministik

Seam yang ada: `users.current_mood` / `mood_updated_at` (`schema.sql:17`), dibaca `service.ts:332` `getPromptState`, dirender `context.ts:40`. `setMood` ada (`service.ts:343`).

Yang dihitung kode (tiap `context.build`), tanpa LLM:

- **energy** = f(jam lokal): malam rendah, pagi groggy, siang mid, sore hangat.
- **missYou** = f(`lastUserMessageAt` gap, sudah ada): >8 jam tinggi.
- **affection** (0–1): naik dari pesan manis, turun dari cuek/kasar. Decay pelan.
- **ngambek**: dipicu cuek atau kasar (mis. "NTAHLAH"). Ambang + durasi terbatas (`C3`), lalu repair beat (luluh).

Arah teknis: hitung vektor mood di kode → tulis ke `current_mood`/`mood_updated_at` → render ke dynamic block sebagai `Mood sekarang: <cue bahasa natural>` + `Jangan ulangi: ...`. Simpan parameter (affection, ngambek-until) di `settings_json` (`schema.sql:22`) atau kolom baru — **call builder**. LLM tak mengarang state; ia hanya *membaca cue* dan memetakannya ke suara.

### 6.3 Guard anti-pengulangan

- Persist last-N (~5) **opening**, **ending**, dan **emoji set** balasan asisten.
- Render ke dynamic block: `Jangan ulangi: <daftar>`.
- Opsional post-filter di `telegram.ts` `deliver` (`telegram.ts:340`): tolak bubble identik dengan yang baru, minta ulang sekali.

### 6.4 Variasi bentuk & cadence

- Aturan bentuk di persona (§6.1) + injector target-shape dari mood vector di `context.ts`.
- `splitDynamicBubbles` (`telegram.ts:366`) sudah biarkan 1 bubble untuk teks ≤220 char tanpa `\n\n` — masalahnya model selalu keluarkan `\n\n`. Perbaikan utama di prompt, bukan splitter.
- Cadence (`telegram.ts:340-357`, `computeDynamicTypingDelay`) sekarang metronomik. **Call builder:** apakah perlu delay bervariasi (burst/long-pause)? Rekomendasi: tunda (gimmick risk), persona dulu.

### 6.5 Turn task (A9)

- Persona dapat aturan: saat membantu/menjawab teknis, tetap suara Fanya, dilarang bullet/arrow, tetap natural.

## 7. Prioritas (diputuskan)

Urutan implementasi & alasan ROI:

1. **G1 de-anchor contoh** (prompt-only, nol kode). Bunuh leak terbukti.
2. **G6+G2 ending netral + guard anti-ulang** (kode kecil). Bunuh tell terukur.
3. **G3 mood/energy deterministik** (kode sedang). Pakai seam mati.
4. **G5 variasi bentuk** (prompt + injector kecil).
5. **G4 affection/ngambek** (kode sedang–besar, risiko emosional) — **jalankan log-only dulu** untuk kalibrasi, baru aktifkan.
6. **G7 timing/"life"** (prompt dulu, timer nanti).
7. **G8 engine state penuh** — hanya setelah 1/2/3 terbukti.

## 8. Yang diserahkan ke builder

- Skema penyimpanan state emosi: `settings_json` vs kolom baru vs tabel `persona_state`.
- Rentang nilai & kurva decay mood/affection/ngambek (bersama kalibrasi `C3`).
- Cara render cue mood → bahasa (template statis vs daftar kata).
- Apakah guard anti-ulang pakai exact-match atau similaritas (Jaccard) — rekomendasi: exact dulu.
- Seed pseudo-random untuk variasi bentuk agar reproducible (opsional).

## 9. Verifikasi

- Probe suite: 20 situasi skrip → ukur (a) overlap verbatim vs string persona (target ~0), (b) distribusi bubble-count (ada 1-bubble), (c) proporsi ending netral ≥ ~60%, (d) palette emoji bervariasi.
- Unit test: `getPromptState` mengekspos mood cue; guard menolak pengulangan; `splitDynamicBubbles` tetap benar.
- Jalankan dengan bot distop dulu bila menyentuh `data/fanya.db` (`pnpm db:clean` EPERM kalau bot pegang DB).
- Gate: `pnpm typecheck` bersih; 6 kegagalan test pre-existing tetap pre-existing (bukan regresi).

## 10. Resolusi Builder Check (call builder)

Delapan pertanyaan builder. Semua disettle di sini; tak ada yang perlu owner.

1. **Model produksi** — *terjawab dari config*: `nemotron-3-ultra-550b-a55b` (550B MoE). Plan tetap prompt+kode.
2. **Deteksi "manis/kasar/cuek"** (C4 tetap deterministik) — *call*: sinyal dari **heuristik kode** (daftar kata/pattern kasar-cuek; deteksi penolakan perhatian via `unanswered_proactive_count`). `PostTurnWriter` (`writer.ts:43`) **berhenti menulis `current_mood`** — engine baru yang memiliki field itu. Ekstraktor LLM boleh tetap jalan untuk facts/commitments, tapi `mood` dibuang dari schema ekstraksi (atau dipindah ke kolom sentiment terpisah yang **bukan** sumber mood engine).
3. **missYou vs ngambek** — *call*: **diam saja → missYou naik, BUKAN ngambek.** Ngambek hanya dari sinyal eksplisit kasar-cuek atau mengabaikan proactive (unanswered). Keduanya boleh koeksis: ngambek mewarnai tone, missYou jadi undertone rindu.
4. **Mood gate proactive wakeup?** — *call*: mood **mewarnai, tidak menekan**. Reminder agenda tetap terkirim apa pun mood. Greeting boleh lebih dingin/ringkas saat ngambek. Spontaneous boleh di-skip kalau ngambek berat (opsional, builder).
5. **Input delta mood** — *call*: pakai **kata owner asli saja**. Untuk turn command, `telegram.ts:317-338` menyimpan `[SYSTEM COMMAND: ...]` sebagai pesan user — turn command **di-skip** dari perhitungan delta mood (jangan analisis prompt sistem).
6. **`tone-examples.md` runtime?** — *call*: **doc-only** (referensi manusia), TIDAK diinjeksi ke prompt (hindari biaya token & re-anchoring). Descriptor inti cukup hidup di `persona.md`.
7. **G4 log-only** — *call*: log keputusan affection/ngambek (nilai + alasan) ke tabel/log; feature-flag `ngambekEnabled`; flip ke aktif setelah kalibrasi ~1 minggu. Ambang/timing = call builder bersama C3.
8. **Probe-suite** — *call*: **recorded fixtures** untuk uji deterministik unit-level; live-call opsional sebagai smoke test manual (bukan CI, karena LLM nondeterministik).