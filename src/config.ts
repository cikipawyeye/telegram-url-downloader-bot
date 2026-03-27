export type AppConfig = {
  port: number;
  botToken: string;
  publicBaseUrl: string;
  webhookSecret: string;
  telegramApiRoot?: string;
  downloadDir: string;
  maxFileSizeBytes: number;
  downloadTimeoutMs: number;
  screenshotCount: number;
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
    maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 2147483648),
    downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 900000),
    screenshotCount: Number(process.env.SCREENSHOT_COUNT ?? 5),
  };
}
