# Audit Bug & Potensi Bug

Audit read-only pada bot ini menemukan beberapa jalur yang membuat unduhan
berhenti permanen, pesan status menggantung, atau file rusak terkirim. Dokumen
ini mencatat temuan tersebut dan status perbaikannya.

Legenda status: ✅ diperbaiki · ⬜ belum diperbaiki (dampak sudah dimitigasi)
· ℹ️ catatan/konfigurasi.

---

## Kritis

### K1. `status_message_id` UNIQUE lintas chat ✅
**Lokasi:** `src/storage/database.ts`

`message_id` Telegram hanya unik di dalam satu chat, tetapi skema lama memakai
`status_message_id INTEGER NOT NULL UNIQUE`. Dua chat yang kebetulan memakai id
pesan yang sama membuat `createJob` chat kedua gagal, sehingga balasan
"Link diterima..." tidak pernah dikirim dan chat itu tampak diam.

**Perbaikan:** migrasi v5 membangun ulang tabel `jobs` dengan
`UNIQUE(chat_id, status_message_id)`. Semua query cancel sekarang menyertakan
`chat_id`. Data job/job_items lama dipertahankan.

### K2. Job sukses tidak pernah ditutup ✅
**Lokasi:** `src/video/process-message.ts`

`finishJob()` hanya dipanggil untuk `failed`/`cancelled`. Jalur sukses
meninggalkan `jobs.status='running'` selamanya, `done_urls=0`, dan
`finished_at=NULL`.

**Perbaikan:** `finishJob(jobId, 'completed')` dipanggil di akhir batch.
`failed` dipakai hanya bila tidak ada satu pun item yang berhasil.

### K3. Stop diabaikan saat screenshot / split / kirim ✅
**Lokasi:** `src/video/process-message.ts`, `src/video/screenshots.ts`,
`src/video/splitter.ts`

Setelah download selesai, tidak ada pengecekan `signal.aborted` sebelum
membuat screenshot, memecah video, atau mengirim. Pesan berubah menjadi
"Unduhan dihentikan." tetapi video tetap terkirim.

**Perbaikan:** `throwIfCancelled()` ditambahkan sebelum/sesudah setiap fase dan
di antara pengiriman. Screenshot generator dan splitter sekarang menerima
`AbortSignal` dan mematikan proses ffmpeg saat Stop.

### K4. Webhook 10 detik + Express 4 → crash / duplikat ✅
**Lokasi:** `src/index.ts`, `src/telegram/register-handlers.ts`

Default grammy `timeoutMilliseconds: 10000` + `onTimeout: 'throw'`. Express 4
tidak menangkap rejection async, sehingga kegagalan menjadi
`unhandledRejection` dan mematikan proses. `/audio` menunggu seluruh ekstraksi
di dalam handler, hampir selalu melewati 10 detik; Telegram lalu mengirim ulang
update dan file diproses dua kali.

**Perbaikan:** timeout webhook 60 detik dengan `onTimeout: 'return'`; `/audio`
dijalankan di background (`void ... .catch(...)`); wrapper route menangkap
rejection; error handler Express dan `process.on('unhandledRejection')`
ditambahkan.

### K5. `trunc` preallocation + cek ukuran → resume mengirim file rusak ✅
**Lokasi:** `src/video/downloader.ts`

`aria2c --file-allocation=trunc` langsung membuat file sebesar ukuran penuh.
Setelah proses dibunuh, file tampak "lengkap" dan `existing.size >= length`
membuat unduhan berikutnya melewati download lalu mengirim file sparse/rusak.

**Perbaikan:** `--file-allocation=none`; file dianggap lengkap hanya jika
ukurannya tepat **dan** tidak ada control file `*.aria2`; setelah download,
ukuran dan control file diverifikasi sebelum file dikirim.

### K6. Pesan status bisa terkunci dan tidak pernah tuntas ✅
**Lokasi:** `src/telegram/notifier.ts`, `src/video/process-message.ts`

`deleteStatus()` menutup notifier sebelum delete; jika delete gagal, semua
update berikutnya menjadi no-op dan pesan "Sedang mengirim..." menggantung.
Catch batch juga hanya mengubah teks tanpa menghapus tombol Stop.

**Perbaikan:** flag `statusMessageClosing` membedakan "sedang menutup" dari
"tutup permanen"; delete yang gagal tidak mengunci notifier. `failStatus()`
menghapus tombol Stop dalam edit terakhir. `confirmStopped()` juga tidak lagi
mengunci notifier bila edit gagal.

---

## Tinggi

### T1. Slot download global + retry 10×15 menit ✅
Default lama: `DOWNLOAD_CONCURRENCY=1`, timeout 15 menit, retry 10 kali. Satu
link mati dapat menahan slot global hingga ~25 jam dan memblokir semua chat.

**Perbaikan:**
- Error diklasifikasi menjadi `permanent` (video privat/unavailable, login/usia,
  geo-block, URL/format tidak didukung, HTTP 400/401/403/404/410/451, disk/izin,
  batas torrent) dan `transient` (timeout, reset koneksi, DNS, HTTP 429/5xx,
  peer torrent belum ada). Error permanen hanya dicoba **sekali**.
- Error proxy (`ProxyError`, `Socks5Error`, `connection refused` saat proxy
  aktif) tetap **transient**. Bot menunggu port proxy lokal menerima koneksi
  (probe TCP, default maksimal 120 detik) sebelum mencoba lagi; percobaan tetap
  dihitung, tetapi tidak dihabiskan saat proxy belum siap.
- Default percobaan turun menjadi `DOWNLOAD_RETRIES=3` (total attempt) dengan
  backoff eksponensial `2s, 4s, ...` (maksimal 60 detik + jitter).
- `DOWNLOAD_RETRY_BUDGET_MS` (default 30 menit) membatasi jeda retry dan
  dimulainya percobaan berikutnya. Percobaan yang sedang berjalan tetap dibatasi
  `DOWNLOAD_TIMEOUT_MS`, jadi budget bukan hard-kill di tengah download.
  Bila budget habis, percobaan berikutnya tidak dijalankan dan link berhenti
  dengan pesan yang jelas.
- Slot global dan reservasi disk sekarang diambil **per attempt** dan dilepas
  sebelum backoff, sehingga link yang menunggu retry tidak memblokir chat lain.
  Workspace/partial tetap dipakai ulang sehingga resume tidak rusak.
- Pesan status membedakan error permanen (`Tidak akan dicoba ulang.`), error
  sementara, penantian proxy, dan saran `noproxy <link>` saat proxy mati.
- Dokumen ini tidak mengklaim deteksi download mandek; timeout tetap per attempt
  (`DOWNLOAD_TIMEOUT_MS`).

### T2. Prefetch tanpa back-pressure ⬜
Prefetch mengunduh semua link batch sementara pengiriman berurutan; disk bisa
penuh sebelum link terakhir sempat dikirim. `DiskSpaceGuard` hanya menunggu
4×15 detik.

### T3. `expandItems` sekuensial & tidak bisa dibatalkan penuh ✅ (sebagian)
**Perbaikan:** Stop dicek sebelum dan sesudah setiap ekspansi; batch berhenti
sebagai `cancelled`. Permintaan metadata yang sedang berjalan tetap tidak bisa
dibatalkan karena API `expandUrl` belum menerima signal.

### T4. Splitter `-map 0` gagal untuk MKV dengan subtitle ✅
**Lokasi:** `src/video/splitter.ts`

`-map 0` menyalin subtitle ASS/PGS yang tidak didukung MP4, menghasilkan part
0 byte. **Perbaikan:** hanya `0:v:0` + `0:a:0?` (plus `-sn -dn`). Direktori
`segments-*` sekarang dibersihkan saat gagal maupun setelah retry berhasil.

### T5. TDZ `timer` → `ReferenceError` saat abort awal ✅
**Lokasi:** `src/video/converter.ts`, `src/audio/extractor.ts`,
`src/video/downloader.ts`, `src/video/process-message.ts`

`cleanup()`/`onAbort` bisa berjalan sebelum `const timer` diinisialisasi.
**Perbaikan:** `let timer: NodeJS.Timeout | undefined` dideklarasikan sebelum
handler, dengan guard `clearTimeout`. Diuji: abort awal sekarang menghasilkan
`DownloadCancelledError`, bukan `ReferenceError`.

### T6. Cancel map & callback tanpa cek chat ✅
**Perbaikan:** key in-memory sekarang `${chatId}:${statusMessageId}`; handler
Stop mengambil `ctx.chat.id`; DB cancel memakai `(chat_id, status_message_id)`.
Callback yang menargetkan chat lain tidak lagi mengenai job chat tersebut.

### T7. Audio tanpa slot, disk guard, dan cek ukuran sumber ✅ (sebagian)
**Perbaikan:** ukuran video sumber dicek terhadap `MAX_FILE_SIZE_BYTES` sebelum
diunduh; workspace dibuat di dalam `try` sehingga kegagalan tidak
meninggalkan file; error memakai `failStatus()`. Slot/disk guard bersama belum
dihubungkan ke jalur audio.

### T8. Konfigurasi deploy tidak konsisten ✅
**Lokasi:** `docker-compose.yml`, `src/config.ts`

`PORT=8000` tetapi compose memetakan `${PORT}:3000`. **Perbaikan:** compose
memetakan `${PORT}:${PORT}` sehingga port host, container, dan `app.listen`
selalu sama. Semua angka env divalidasi; `MAX_FILE_SIZE_BYTES` default 50 MB
saat memakai Bot API standar.

### T9. Webhook tanpa secret token ✅
**Perbaikan:** `WEBHOOK_SECRET_TOKEN` opsional diteruskan ke `setWebhook`
sebagai `secret_token` dan divalidasi oleh grammy lewat opsi `secretToken`.
Bila env kosong, perilaku lama dipertahankan.

### T10. Batas upload vs Bot API standar ✅
Default lama 2 GB membuat hampir semua video gagal di `sendVideo` setelah
diunduh penuh. **Perbaikan:** default 50 MB tanpa `TELEGRAM_API_ROOT`, 2 GB
dengan local Bot API server.

---

## Sedang

| # | Temuan | Status |
|---|--------|--------|
| S1 | `buildDeliveryFileName('/x.mp4','Movie.mp4')` → `Movie.mp4.mp4` | ✅ ekstensi judul yang sama tidak ditambahkan dua kali |
| S2 | `SCREENSHOT_COUNT>9` / album >10 item ditolak Telegram | ✅ config dibatasi 1–9 dan notifier memotong album ke 10 item |
| S3 | Screenshot resolusi penuh bisa >10 MB | ✅ screenshot di-scale maksimal 1920 px |
| S4 | Magnet base32 tidak memakai cache `.torrent` | ✅ base32 didekode ke hex untuk lookup cache |
| S5 | Salin cache metadata magnet non-atomik | ⬜ error salin masih diabaikan |
| S6 | `MAX_BULK_URLS` NaN mematikan batas | ✅ divalidasi; batas hasil ekspansi album/magnet belum diterapkan |
| S7 | `engines.node >=20` padahal `node:sqlite` butuh >=22.5 | ✅ diubah ke `>=22.5.0` |
| S8 | HELP_TEXT maksimal 10 link vs kode 20 | ✅ disamakan menjadi 20 |
| S9 | Tanpa allowlist user; URL http(s) arbitrer ke yt-dlp | ⬜ perlu keputusan produk (SSRF) |
| S10 | Restart meninggalkan job `running` dan item `pending` | ✅ `recoverInterruptedJobs()` dipanggil saat startup |

---

## Rendah

| # | Temuan | Status |
|---|--------|--------|
| R1 | Progress audio di-`void` tanpa catch → unhandled rejection | ⬜ |
| R2 | `probe` audio tidak menerima signal | ✅ |
| R3 | Antrean media per-chat tanpa timeout | ⬜ |
| R4 | `deleteStatus` gagal tidak menampilkan status akhir | ✅ tidak lagi mengunci pesan berikutnya |
| R5 | Dokumentasi usang (default 2 GB, tanpa `WEBHOOK_SECRET_TOKEN`, perilaku Stop/restart) | ✅ README dan `.env.example` diselaraskan dengan kode |

---

## Verifikasi

- `npx tsc -p tsconfig.json --noEmit` — lolos.
- Seluruh `scripts/*-check.ts` — lolos.
- Migrasi v4 → v5 diuji dengan DB berisi job + job_item: data tetap, dua chat
  boleh memakai `status_message_id` yang sama, foreign key kembali aktif.
- TDZ diuji: abort sebelum proses dimulai menghasilkan
  `DownloadCancelledError`.
- Splitter diuji dengan MKV ber-subtitle ASS: part berhasil dibuat (sebelumnya
  0 byte) dan direktori retry lama dibersihkan.
- `buildDeliveryFileName` diuji untuk judul yang sudah berisi ekstensi.
- `scripts/retry-policy-check.ts` menguji klasifikasi permanen/transient/proxy,
  batas jumlah attempt, retry budget, pelepasan slot saat backoff, Stop saat
  backoff, proxy yang pulih setelah probe, dan proxy mati dengan saran
  `noproxy`.
- `README.md` dan `.env.example` dicek ulang terhadap `config.ts` dan perilaku
  kode: default `MAX_FILE_SIZE_BYTES` (50 MiB standar / 2 GiB local Bot API),
  `DOWNLOAD_TIMEOUT_MS`, retry/budget/proxy wait, `SCREENSHOT_COUNT`,
  `MAX_BULK_URLS`, `WEBHOOK_SECRET_TOKEN`, port Compose, dan perilaku
  Stop/restart.
