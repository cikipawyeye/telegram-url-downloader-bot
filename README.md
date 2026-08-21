# Telegram Video Downloader Bot

Bot ini menerima URL dari user, mencoba mengunduh videonya dengan `yt-dlp`, lalu mengirim balik ke Telegram sebagai **video** agar bisa **di-stream langsung di Telegram**.

## Fitur
- menerima link dari user via Telegram
- bulk download hingga 10 URL dalam satu pesan (diproses berurutan)
- webhook-ready untuk deployment
- download dengan `yt-dlp`
- unduh Bunkr (`https://*.bunkr.*/file/<id>` atau `/f/<id>`) pakai custom downloader (detail API → sign token → media), dengan dukung progress & batalkan
- kirim kembali memakai `sendVideo` + `supports_streaming: true`
- auto cleanup file sementara
- auto split video yang melebihi batas upload menjadi beberapa part
- menu `/convert` untuk mengubah ukuran video ke resolusi 1080p / 720p / 480p / 240p (kompatibel streaming di Telegram)
- screenshot + video dikirim dalam satu album/media group (bisa dimatikan dengan `SEND_VIDEO_IN_ALBUM=false`)
- health check endpoint

## Struktur kode
Struktur kode sekarang dibuat lebih langsung per kebutuhan fitur, bukan per layer:

```text
src/
  index.ts                  # bootstrap aplikasi
  config.ts                 # load environment config
  http/                     # Express app dan endpoint health check
  storage/                  # workspace temp file
  telegram/                 # handler dan notifier Telegram
  video/                    # download, screenshot, util, dan flow utama
```

Alur request tetap sama:
1. User mengirim URL ke bot
2. Server menerima webhook Telegram
3. Server menjalankan `yt-dlp`
4. File disimpan sementara
5. Bot membuat 5 screenshot dari durasi video
6. Kalau video melebihi `MAX_FILE_SIZE_BYTES`, bot memecah video menjadi beberapa part dengan `ffmpeg`
7. Bot mengirim screenshot lalu video ke user
8. File sementara dihapus

### Satu album (screenshot + video)
Secara default bot mengirim screenshot beserta video dalam **satu album/media group** (video diletakkan paling depan agar judulnya tampil sebagai caption album). Catatan:
- Video dalam album dikompres/diturunkan kualitasnya oleh Telegram dibanding `sendVideo` biasa (yang bisa di-stream dalam kualitas penuh).
- Batas media group adalah **maksimal 10 item** dan **hanya caption item pertama** yang ditampilkan.
- Kalau video terpecah jadi beberapa part, atau jumlah item melebihi 10, bot otomatis fallback ke pengiriman terpisah (screenshot sendiri, video sendiri).
- Untuk tetap mengirim video full-quality streamable, set `SEND_VIDEO_IN_ALBUM=false`.

## Penting
Agar bot bisa mengirim file besar, sebaiknya gunakan **local/self-hosted Telegram Bot API** dan isi `TELEGRAM_API_ROOT`.

Contoh:
- `TELEGRAM_API_ROOT=http://127.0.0.1:8081`

Kalau pakai Bot API Telegram standar, limit upload bot jauh lebih kecil.

Sebelum menjalankan local bot, logout di API Telegram standar: `curl "https://api.telegram.o
rg/bot<TOKEN>/logOut"`

See: https://github.com/tdlib/telegram-bot-api

## Environment
Salin `.env.example` menjadi `.env` lalu isi nilainya.

`MAX_FILE_SIZE_BYTES` default-nya `2147483648` (2 GiB). Video yang lebih besar dari nilai ini akan dikirim sebagai beberapa part.

## Menjalankan lokal
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

## Reverse proxy
Arahkan domain HTTPS kamu ke port aplikasi, lalu set:
- `PUBLIC_BASE_URL=https://bot.domainkamu.com`
- `WEBHOOK_SECRET=string-rahasia-panjang`

Webhook akan dibuat otomatis ke:
`/telegram/webhook/<WEBHOOK_SECRET>`

## Health check
- `GET /health`

## Catatan operasional
- `ytdlp-nodejs` akan mengelola binary `yt-dlp` saat dependency di-install
- Pastikan `ffmpeg` tersedia untuk proses merge/remux yang dibutuhkan `yt-dlp`
- Gunakan storage SSD
- Jadwalkan monitoring disk usage
- Untuk trafik besar, pindahkan proses download ke queue/worker terpisah
