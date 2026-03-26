# Telegram Video Downloader Bot

Bot ini menerima URL dari user, mencoba mengunduh videonya dengan `yt-dlp`, lalu mengirim balik ke Telegram sebagai **video** agar bisa **di-stream langsung di Telegram**.

## Fitur
- menerima link dari user via Telegram
- webhook-ready untuk deployment
- download dengan `yt-dlp`
- kirim kembali memakai `sendVideo` + `supports_streaming: true`
- auto cleanup file sementara
- pembatasan ukuran file
- health check endpoint

## Arsitektur singkat
Struktur kode sekarang dipisah menjadi beberapa layer:

```text
src/
  index.ts                  # composition root / bootstrap
  config/                   # load env dan app config
  domain/                   # entity + helper murni
  application/             # port + use case
  infrastructure/          # filesystem, process runner, yt-dlp adapter
  interfaces/              # adapter Express dan Telegram
```

Alur request tetap sama:
1. User mengirim URL ke bot
2. Server menerima webhook Telegram
3. Server menjalankan `yt-dlp`
4. File disimpan sementara
5. Bot mengirim video ke user
6. File sementara dihapus

## Penting
Agar bot bisa mengirim file besar, sebaiknya gunakan **local/self-hosted Telegram Bot API** dan isi `TELEGRAM_API_ROOT`.

Contoh:
- `TELEGRAM_API_ROOT=http://127.0.0.1:8081`

Kalau pakai Bot API Telegram standar, limit upload bot jauh lebih kecil.

Sebelum menjalankan local bot, logout di API Telegram standar: `curl "https://api.telegram.o
rg/bot<TOKEN>/logOut"`

## Environment
Salin `.env.example` menjadi `.env` lalu isi nilainya.

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

## Reverse proxy
Arahkan domain HTTPS kamu ke port aplikasi, lalu set:
- `PUBLIC_BASE_URL=https://bot.domainkamu.com`
- `WEBHOOK_SECRET=string-rahasia-panjang`

Webhook akan dibuat otomatis ke:
`/telegram/webhook/<WEBHOOK_SECRET>`

## Health check
- `GET /health`

## Catatan operasional
- Pastikan `ffmpeg` dan `yt-dlp` tersedia
- Gunakan storage SSD
- Jadwalkan monitoring disk usage
- Untuk trafik besar, pindahkan proses download ke queue/worker terpisah
