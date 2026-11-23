# Telegram Video Downloader Bot

Bot ini menerima URL dari user, mencoba mengunduh videonya dengan `yt-dlp`, lalu mengirim balik ke Telegram sebagai **video** agar bisa **di-stream langsung di Telegram**.

## Fitur
- menerima link dari user via Telegram
- bulk download hingga 20 URL dalam satu pesan (bisa diubah lewat `MAX_BULK_URLS`); unduhan link berikutnya sudah jalan (prefetch) selagi link sebelumnya dikonversi/dikirim, sedangkan pengiriman ke Telegram tetap berurutan
- webhook-ready untuk deployment
- download dengan `yt-dlp`
- perintah `/audio`: balas (reply) pesan video dari bot untuk mengekstrak audionya lalu mengirimnya kembali sebagai MP3
- override tanpa proxy per pesan dari Telegram (`noproxy <link>` atau `/noproxy <link>`), berguna kalau proxy justru bikin link gagal
- unduh Bunkr (`https://*.bunkr.*/file/<id>` atau `/f/<id>`) pakai custom downloader (detail API → sign token → media), dengan dukung progress & batalkan
- URL album Bunkr (`/a/<id>`) otomatis diperluas menjadi bulk download video saja; gambar diabaikan
- link Google Drive (`drive.google.com`, `docs.google.com/uc?id=...`) diunduh dengan binary `gdown` kalau tersedia (termasuk link folder via `--folder`), lengkap dengan progress; tanpa `gdown`, otomatis fallback ke `yt-dlp`
- link magnet torrent (`magnet:?xt=urn:btih:...`) diunduh dengan binary `aria2c`: metadata torrent diambil dulu, lalu setiap file video di dalamnya dikirim berurutan sebagai video terpisah (file non-video diabaikan); ada progress per file, batas ukuran per file (`MAGNET_MAX_FILE_SIZE_BYTES`), dan resume otomatis saat link dikirim ulang
- kirim kembali memakai `sendVideo` + `supports_streaming: true`
- kalau ada link yang gagal, alasan errornya ditampilkan di pesan status (per link dan di ringkasan akhir), bukan hanya jumlah keberhasilan/gagal
- auto cleanup file sementara
- auto split video yang melebihi batas upload menjadi beberapa part
- menu `/convert` untuk mengubah ukuran video ke resolusi 1080p / 720p / 480p / 240p (kompatibel streaming di Telegram)
- tag/label unduhan: `/tag <nama>` menandai unduhan berikutnya, `/tags` melihat daftar tag beserta jumlahnya, dan `/tags <nama>` melihat riwayat unduhan per tag (tersimpan di SQLite); tag juga tampil sebagai `#tag` di caption video dan screenshot yang dikirim
- screenshot + video dikirim dalam satu album/media group (bisa dimatikan dengan `SEND_VIDEO_IN_ALBUM=false`)
- health check endpoint

## Struktur kode
Struktur kode sekarang dibuat lebih langsung per kebutuhan fitur, bukan per layer:

```text
src/
  index.ts                  # bootstrap aplikasi
  audio/                    # ekstraksi audio dari video (ffmpeg) dan alur /audio
  config.ts                 # load environment config
  http/                     # Express app dan endpoint health check
  storage/                  # workspace temp file + disk admission guard
  tags/                     # normalisasi tag dan teks daftar/riwayat tag
  telegram/                 # handler, notifier, dan pengambil file dari Telegram
  video/                    # download, prefetch/limit unduhan, screenshot, util, dan flow utama
```

Alur request tetap sama:
1. User mengirim URL ke bot
2. Server menerima webhook Telegram
3. Server menjalankan `yt-dlp`
4. File disimpan sementara
5. Bot membuat screenshot dari durasi video (`SCREENSHOT_COUNT`, default 5, maksimal 9)
6. Kalau video melebihi `MAX_FILE_SIZE_BYTES`, bot memecah video menjadi beberapa part dengan `ffmpeg`
7. Bot mengirim screenshot lalu video ke user
8. File sementara dihapus

### Satu album (screenshot + video)
Secara default bot mengirim screenshot beserta video dalam **satu album/media group** (video diletakkan paling depan agar judulnya tampil sebagai caption album). Catatan:
- Video dalam album dikompres/diturunkan kualitasnya oleh Telegram dibanding `sendVideo` biasa (yang bisa di-stream dalam kualitas penuh).
- Batas media group adalah **maksimal 10 item** dan **hanya caption item pertama** yang ditampilkan.
- Kalau video terpecah jadi beberapa part, atau jumlah item melebihi 10, bot otomatis fallback ke pengiriman terpisah (screenshot sendiri, video sendiri).
- Untuk tetap mengirim video full-quality streamable, set `SEND_VIDEO_IN_ALBUM=false`.

### Prefetch unduhan (video besar)
Antrean FIFO per chat sekarang hanya mengatur **pengiriman**, bukan unduhan:

1. Saat link diterima, bot langsung mengunduh (prefetch) tanpa menunggu giliran kirim.
2. Link yang sedang diunduh tetapi belum giliran tetap menampilkan progress di pesan statusnya.
3. Pengiriman (konversi, screenshot, split, upload) tetap berurutan sesuai urutan link, jadi urutan media di Telegram tidak berubah.

Batasnya:
- `DOWNLOAD_CONCURRENCY` (default `1`) — jumlah unduhan bersamaan untuk **seluruh** chat. Nilai `1` sudah membuat unduhan link berikutnya jalan selagi link sekarang dikirim.
- `DOWNLOAD_TIMEOUT_MS` (default 15 menit) — batas waktu satu percobaan unduhan. Error permanen (video privat/unavailable, login/usia, geo-block, HTTP 400/401/403/404/410/451, format tidak didukung) langsung gagal tanpa retry. Error sementara dicoba ulang sampai total `DOWNLOAD_RETRIES` percobaan (default 3) dengan backoff eksponensial dari `DOWNLOAD_RETRY_BACKOFF_MS` (default 2 detik, maksimal 60 detik). Jeda retry dan dimulainya percobaan berikutnya dibatasi `DOWNLOAD_RETRY_BUDGET_MS` (default 30 menit); percobaan yang sedang berjalan tetap tunduk pada `DOWNLOAD_TIMEOUT_MS`. Slot download global dilepas selama jeda sehingga link yang menunggu retry tidak memblokir chat lain. Jika `YTDLP_PROXY` menolak koneksi, bot menunggu port proxy lokal siap (probe TCP, default maksimal `DOWNLOAD_PROXY_WAIT_MS` 120 detik) lalu mencoba lagi; penantian ini tetap dihitung terhadap budget.
- `MIN_FREE_DISK_BYTES` (default 6 GiB) dan `DOWNLOAD_RESERVE_BYTES` (default 4 GiB) — sebelum unduhan dimulai, bot memastikan sisa disk masih cukup. Untuk video 4 GB+ yang dipecah menjadi part, satu job butuh ruang untuk file asli **dan** hasil split (sekitar 2x ukuran file), jadi naikkan `MIN_FREE_DISK_BYTES` bila ukuran file biasanya 4 GB atau lebih (mis. `12884901888` = 12 GiB).
- Kalau ruang tidak cukup, link tersebut gagal dengan alasan yang jelas (bukan error ffmpeg/ENOSPC), dan pesan menyebutkan berapa GB yang tersedia/dibutuhkan.
- Kalau ruang sedang penuh karena file yang baru dikirim belum dihapus, bot menunggu sekitar 15 detik (sampai 4 kali percobaan) sebelum menyatakan link gagal, sehingga batch video besar di disk ketat tidak langsung putus. Tombol Stop tetap bisa menghentikan penantian ini.
- Saat pengguna menekan Stop: pesan status langsung berubah menjadi "Unduhan dihentikan." dan tombolnya hilang, termasuk untuk pesan yang masih antre (tidak menunggu batch sebelumnya selesai). Unduhan yang sudah selesai tetapi belum terkirim dihapus, sedangkan unduhan yang masih berjalan dibiarkan sebagai file parsial supaya bisa dilanjutkan saat link dikirim ulang.

## Penting
Agar bot bisa mengirim file besar, gunakan **local/self-hosted Telegram Bot API** dan isi `TELEGRAM_API_ROOT`.

Contoh:
- `TELEGRAM_API_ROOT=http://127.0.0.1:8081`

Bot API Telegram standar hanya menerima upload bot sampai **50 MB** dan download file sampai **20 MB**. Tanpa `TELEGRAM_API_ROOT`, `MAX_FILE_SIZE_BYTES` karena itu default ke 50 MiB; video yang lebih besar dipecah menjadi beberapa part selama masih di bawah batas tersebut.

Sebelum menjalankan local bot, logout di API Telegram standar: `curl "https://api.telegram.org/bot<TOKEN>/logOut"`

See: https://github.com/tdlib/telegram-bot-api

## Environment
Salin `.env.example` menjadi `.env` lalu isi nilainya. Semua nilai numerik divalidasi; nilai kosong atau tidak valid memakai default.

Batas ukuran upload (`MAX_FILE_SIZE_BYTES`):
- tanpa `TELEGRAM_API_ROOT`: default `52428800` (50 MiB, batas Bot API standar)
- dengan `TELEGRAM_API_ROOT`: default `2147483648` (2 GiB)
- video yang lebih besar dari nilai ini dipecah menjadi beberapa part; nilai ini juga dipakai sebagai batas ukuran video sumber untuk `/audio`

Konfigurasi lain yang sering disesuaikan:
- `SCREENSHOT_COUNT` — jumlah screenshot, default `5`, otomatis dibatasi 1–9
- `DOWNLOAD_TIMEOUT_MS` — batas satu percobaan unduhan, default `900000` (15 menit)
- `DOWNLOAD_RETRIES` — total percobaan per link, default `3`; error permanen tetap gagal setelah percobaan pertama
- `DOWNLOAD_RETRY_BACKOFF_MS` — basis jeda retry, default `2000`; jeda berlipat `2s, 4s, ...` dengan batas 60 detik dan jitter
- `DOWNLOAD_RETRY_BUDGET_MS` — batas jeda retry dan dimulainya percobaan berikutnya per link, default `1800000` (30 menit); `0` menonaktifkan batas
- `DOWNLOAD_PROXY_WAIT_MS` — lama menunggu proxy lokal siap setelah `connection refused`, default `120000` (2 menit); `0` melewati penantian
- `MAX_BULK_URLS` — jumlah link maksimal per pesan, default `20`
- `WEBHOOK_SECRET_TOKEN` — opsional, lihat bagian Reverse proxy

## Menjalankan lokal

Prasyarat: **Node.js >= 22.5** (bot memakai modul bawaan `node:sqlite`), `ffmpeg`, `yt-dlp`, dan opsional `aria2c` (magnet) serta `gdown` (Google Drive).

```bash
npm install
cp .env.example .env
npm run dev
```

## Deploy dengan Docker
```bash
cp .env.example .env
docker compose up -d --build
```

`docker-compose.yml` memakai `${PORT}` untuk port host **dan** container sekaligus, jadi ubah `PORT` di `.env` bila port default bentrok. Compose membaca `.env` di direktori yang sama; `docker compose config` bisa dipakai untuk memastikan nilai yang dipakai sudah benar.

## Cloudflare WARP proxy dengan systemd
Proxy dapat diterapkan hanya ke trafik `yt-dlp`, sehingga webhook dan koneksi Telegram tidak ikut melewati WARP.

Ubah WARP ke mode SOCKS5 lokal dan pilih portnya:

```bash
sudo warp-cli proxy port 40000
sudo warp-cli mode proxy
sudo warp-cli connect
warp-cli status
```

Isi environment aplikasi yang dibaca unit systemd:

```dotenv
YTDLP_PROXY=socks5://127.0.0.1:40000
```

Pastikan unit aplikasi dimulai setelah daemon WARP dan menggunakan file environment tersebut:

```ini
[Unit]
After=network-online.target warp-svc.service
Wants=network-online.target
Requires=warp-svc.service

[Service]
EnvironmentFile=/path/to/telegram-video-downloader-bot/.env
```

Setelah mengubah unit atau environment, muat ulang dan restart aplikasi:

```bash
sudo systemctl daemon-reload
sudo systemctl restart nama-service-aplikasi.service
```

`socks5://` membuat resolusi DNS dilakukan oleh host. Jika ingin resolusi DNS juga melalui proxy dan versi `yt-dlp` yang terpasang mendukungnya, gunakan `socks5h://127.0.0.1:40000`.

## Ekstrak audio dari video (`/audio`)
Cara pakai: balas (**reply**) pesan video yang dikirim bot, lalu ketik `/audio`. Bot akan mengambil ulang video tersebut dari Telegram, mengekstrak track audionya menjadi MP3 (VBR ~190 kbps) memakai `ffmpeg`, lalu mengirimnya kembali sebagai audio dengan judul, nama file, dan durasi yang benar.

Detail teknis:
- Pesan balasan yang didukung: video (`sendVideo`) dan dokumen bertipe video; kalau bukan keduanya, bot menjawab petunjuk pemakaian.
- Video diambil lewat `getFile`: dengan local Bot API server (`TELEGRAM_API_ROOT`), `file_path` adalah lokasi file di server sehingga langsung disalin dari disk; tanpa itu (Bot API standar), file diunduh lewat HTTP dari `<API_ROOT>/file/bot<TOKEN>/<path>`.
- Bot API standar hanya bisa mengunduh file sampai **20 MB**. Kalau video yang di-reply lebih besar dari itu dan bot memakai Bot API standar, proses gagal cepat dengan pesan yang menyarankan `TELEGRAM_API_ROOT`. (Local Bot API server bisa mengunduh tanpa batas ukuran juga untuk audio ini.)
- Audio dikirim memakai antrian media yang sama seperti video/screenshot sehingga urutan pesan per chat tetap konsisten.
- Proses `/audio` berjalan di background: handler langsung mengembalikan respons ke Telegram, lalu progres dan hasil dikirim lewat pesan status. Ini mencegah ekstraksi file besar menahan webhook sampai timeout dan diproses dua kali.
- Seperti unduhan video, proses `/audio` menampilkan progres (mengambil file → mengekstrak → mengirim) dan punya tombol ⏹ Hentikan Unduhan yang bisa dibatalkan lewat pesan status. Kalau ukuran video sumber diketahui dan melebihi `MAX_FILE_SIZE_BYTES`, proses gagal cepat sebelum mengunduh. Catatan: alur ini stateless dan tidak dicatat di tabel `jobs`/`job_items` (tabel itu khusus batch URL).

## Tag unduhan (`/tag` & `/tags`)
Tag adalah label yang menempel pada unduhan, berguna untuk mengelompokkan dan mencari riwayat link yang pernah dikirim.

Cara pakai:
- `/tag film` — tag aktif untuk **pesan link berikutnya**. Kirim satu link atau beberapa link sekaligus; semuanya tercatat dengan tag `film`.
- `/tags` — daftar tag di chat ini beserta jumlah unduhannya (terbaru lebih dulu, maksimal 20 tag).
- `/tags film` — 10 riwayat unduhan terakhir dengan tag `film`: status (✅ selesai / ❌ gagal / ⏹ dibatalkan), ukuran file, waktu, dan URL.
- `/tag` tanpa argumen — menampilkan tag aktif beserta petunjuk.
- `/tag off` (juga `-`, `hapus`, dan `clear`) — membatalkan tag aktif.

Detail teknis:
- Tag dinormalisasi sebelum disimpan: dijadikan huruf kecil, `#` di depan dibuang, spasi/tanda baca diubah menjadi `-`, maksimal 32 karakter. Jadi `#Film Korea` dan `film korea` sama-sama menjadi tag `film-korea`.
- Tag bersifat **sekali pakai** (one-shot) untuk satu pesan; setelah pesan link diterima, tag aktif dihapus. Tag juga kedaluwarsa sendiri setelah 1 jam kalau tidak dipakai.
- Tag disimpan per file di kolom `job_items.tag`, jadi ekspansi album (Bunkr/magnet) menandai semua file hasil ekspansi dengan tag yang sama.
- Riwayat dibatasi per chat: di grup, semua anggota melihat riwayat chat tersebut; di private chat, riwayat milik chat itu.
- Riwayat hanya berisi unduhan yang sempat dibuatkan item (kolom `job_items`); link yang gagal total sebelum unduhan dimulai tidak tercatat.
- Tag ditampilkan di hasil kiriman: caption video (dan setiap part kalau video dipecah) diberi baris tambahan `#tag`, dan album screenshot juga memakai caption `#tag`. Tanpa tag, caption tetap seperti biasa (hanya judul video).
- Telegram mengakhiri hashtag pada karakter `-`, jadi `#film-korea` hanya bagian `film` yang otomatis jadi link pencarian. Teks tag tetap ditampilkan lengkap agar sama dengan nilai di `/tags`.
- Pesan status "Link diterima" juga menampilkan tag yang aktif.

## Google Drive dengan `gdown`
Link Google Drive (`https://drive.google.com/file/d/.../view`, `.../open?id=...`, `.../uc?id=...`, `https://drive.usercontent.google.com/download?id=...`) otomatis diunduh memakai binary `gdown` **jika binary tersebut tersedia di PATH**; kalau tidak ada, bot tetap mencoba lewat `yt-dlp` seperti biasa.

- Link folder (`https://drive.google.com/drive/folders/...`) didukung lewat flag `--folder` gdown
- Progress (persentase, ukuran, kecepatan, ETA) dibaca dari output tqdm gdown dan ditampilkan di pesan status, seperti download biasa
- Ketersediaan binary di-probe ulang tiap **5 menit** (bisa diubah lewat env `GDOWN_BINARY_RECHECK_MS`, `0` = tiap request), jadi bot yang sudah berjalan (mis. di systemd) otomatis mendeteksi `gdown` yang di-install/dihapus kemudian **tanpa restart**; setelah cooldown lewat, link Drive berikutnya langsung memakai binary baru
- Kalau `gdown` tidak berada di PATH service — mis. install `pip install --user gdown` (`~/.local/bin/gdown`) padahal systemd tidak memasukkan `~/.local/bin` ke PATH — set env `GDOWN_BINARY_PATH=/home/user/.local/bin/gdown` di `.env`; alternatif lain: symlink ke `/usr/local/bin` atau tambah `Environment="PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin"` di unit systemd
- Timeout (`DOWNLOAD_TIMEOUT_MS`) dan tombol ⏹ Hentikan Unduhan juga berlaku untuk proses gdown
- Proxy `YTDLP_PROXY` diteruskan ke gdown lewat env `HTTP_PROXY`/`HTTPS_PROXY`; override `noproxy <link>` melepas semua env proxy untuk proses gdown
- Image Docker sudah meng-install `gdown` otomatis; kalau menjalankan bot di luar Docker, pasang sendiri: `pip install gdown` atau `pipx install gdown`

## Override tanpa proxy dari pesan Telegram
Kalau ada link yang justru gagal karena proxinya, user bisa mematikan proxy untuk link tersebut langsung dari pesan tanpa mengubah konfigurasi server:

- tulis penanda di pesan: `noproxy <link>`, `!noproxy <link>`, atau `tanpa proxy <link>`
- penanda di baris sendiri berlaku untuk link-link di baris berikutnya:
  ```text
  noproxy
  https://situs-a.com/video
  https://situs-b.com/video
  ```
- atau pakai `/noproxy <link>` untuk memaksa **semua** link di pesan itu tanpa proxy (mis. `/noproxy https://a.com/v1 https://b.com/v2`)

Detail teknis:
- override hanya berlaku pada unduhan `yt-dlp`; download Bunkr tidak memakai proxy sama sekali
- saat override aktif, bot mengirim `--proxy ""` ke `yt-dlp`. Ini adalah cara resmi `yt-dlp` untuk koneksi langsung, sekaligus menimpa env `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` yang mungkin ikut terbaca
- link yang diunduh tanpa proxy ditandai di pesan status (`Memproses 2/3 tanpa proxy...`) dan dicatat di kolom `job_items.no_proxy`
- penanda tidak akan salah dikenali dari dalam URL (mis. `https://situs.com/noproxy` tetap dianggap link biasa)

## Reverse proxy
Arahkan domain HTTPS kamu ke port aplikasi, lalu set:
- `PUBLIC_BASE_URL=https://bot.domainkamu.com`
- `WEBHOOK_SECRET=string-rahasia-panjang`

Webhook akan dibuat otomatis ke:
`/telegram/webhook/<WEBHOOK_SECRET>`

Opsional, lapisan autentikasi kedua: isi `WEBHOOK_SECRET_TOKEN` dengan string acak. Nilai itu dikirim ke `setWebhook` sebagai `secret_token`, dan Telegram mengembalikannya di header `X-Telegram-Bot-Api-Secret-Token` pada setiap update; request tanpa token yang cocok ditolak. Kosongkan untuk mempertahankan perilaku lama.

## Database & pemulihan setelah restart
- Riwayat job dan tag disimpan di SQLite (`DB_PATH`, default `$DOWNLOAD_DIR/bot.db`).
- Skema v5 memakai `UNIQUE(chat_id, status_message_id)` karena message id Telegram hanya unik di dalam satu chat.
- Job yang sukses ditutup sebagai `completed`; job yang gagal total sebagai `failed`.
- Saat startup, job yang masih `running` dari proses sebelumnya ditandai `failed`. Item yang belum selesai ikut ditandai gagal dan file parsialnya dipertahankan, sehingga mengirim ulang link yang sama melanjutkan unduhan dari posisi terakhir, bukan dari nol.
- Stop menyimpan unduhan yang sedang berjalan sebagai file parsial untuk resume, sedangkan unduhan prefetch yang sudah selesai tetapi belum sempat dikirim dihapus agar disk tidak penuh.

## Health check
- `GET /health`

## Catatan operasional
- `ytdlp-nodejs` akan mengelola binary `yt-dlp` saat dependency di-install
- Pastikan `ffmpeg` tersedia untuk proses merge/remux yang dibutuhkan `yt-dlp`
- Gunakan storage SSD
- Jadwalkan monitoring disk usage
- Untuk trafik besar, pindahkan proses download ke queue/worker terpisah
