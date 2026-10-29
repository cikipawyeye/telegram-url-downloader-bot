import path from 'node:path';

export type AppConfig = {
  port: number;
  botToken: string;
  publicBaseUrl: string;
  webhookSecret: string;
  telegramApiRoot?: string;
  downloadDir: string;
  dbPath: string;
  maxFileSizeBytes: number;
  downloadTimeoutMs: number;
  downloadRetries: number;
  downloadRetryBackoffMs: number;
  /** How many links may download at the same time, process-wide. */
  downloadConcurrency: number;
  /** Free space that must stay untouched after active reservations. */
  minFreeDiskBytes: number;
  /** Peak size assumed per running download (a 4 GB+ file plus its split copy). */
  downloadReserveBytes: number;
  ytdlpProxy?: string;
  screenshotCount: number;
  sendVideoInAlbum: boolean;
  reencodeAnamorphic: boolean;
  /** Reject individual torrent files bigger than this (0 = unlimited). */
  magnetMaxFileBytes: number;
  /** Extra BitTorrent tracker URIs for magnet downloads (comma separated). */
  magnetExtraTrackers: string;
};

export function loadConfig(): AppConfig {
  const botToken = process.env.BOT_TOKEN;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  const webhookSecret = process.env.WEBHOOK_SECRET;

  if (!botToken) {
    throw new Error('BOT_TOKEN is required.');
  }

  if (!publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required.');
  }

  if (!webhookSecret) {
    throw new Error('WEBHOOK_SECRET is required.');
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    botToken,
    publicBaseUrl,
    webhookSecret,
    telegramApiRoot: process.env.TELEGRAM_API_ROOT || undefined,
    downloadDir: process.env.DOWNLOAD_DIR ?? '/tmp/telegram-video-bot',
    dbPath: process.env.DB_PATH ?? path.join(process.env.DOWNLOAD_DIR ?? '/tmp/telegram-video-bot', 'bot.db'),
    maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 2147483648),
    downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 900000),
    // Automatic download attempts per link. Retries resume the leftover
    // partial file instead of starting over (see process-message.ts).
    downloadRetries: Number(process.env.DOWNLOAD_RETRIES ?? 10),
    downloadRetryBackoffMs: Number(process.env.DOWNLOAD_RETRY_BACKOFF_MS ?? 2000),
    // Links are prefetched while earlier links are still being converted and
    // sent, so 1 already overlaps download with delivery. Raise it only when
    // the disk can hold several large files at once: each slot may add a 4 GB+
    // download on top of the file currently being sent.
    downloadConcurrency: readNonNegativeNumber(process.env.DOWNLOAD_CONCURRENCY, 1),
    // Keep this above the largest expected peak of one job: a 4 GB video split
    // into parts needs the download plus its parts (about 2x the file size).
    minFreeDiskBytes: readNonNegativeNumber(process.env.MIN_FREE_DISK_BYTES, 6442450944),
    downloadReserveBytes: readNonNegativeNumber(process.env.DOWNLOAD_RESERVE_BYTES, 4294967296),
    ytdlpProxy: process.env.YTDLP_PROXY || undefined,
    screenshotCount: Number(process.env.SCREENSHOT_COUNT ?? 5),
    sendVideoInAlbum: process.env.SEND_VIDEO_IN_ALBUM !== 'false',
    reencodeAnamorphic: process.env.REENCODE_ANAMORPHIC !== 'false',
    // Torrent downloads can be huge and Telegram cannot deliver them anyway;
    // 8 GiB per file is a sane ceiling (split parts still apply downstream).
    magnetMaxFileBytes: readNonNegativeNumber(process.env.MAGNET_MAX_FILE_SIZE_BYTES, 8 * 1024 * 1024 * 1024),
    magnetExtraTrackers: process.env.MAGNET_EXTRA_TRACKERS ?? '',
  };
}

/** Env numbers are optional; a missing or malformed value keeps the default. */
function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
