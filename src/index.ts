import 'dotenv/config';
import { hydrateFiles } from '@grammyjs/files';
import type { NextFunction, Request, Response } from 'express';
import { Bot, type Context, webhookCallback } from 'grammy';
import { YtDlp } from 'ytdlp-nodejs';
import { AudioExtractor } from './audio/extractor.js';
import { AudioMessageProcessor } from './audio/process-audio-reply.js';
import { loadConfig } from './config.js';
import { createHttpApp } from './http/create-app.js';
import { BotDatabase } from './storage/database.js';
import { DiskSpaceGuard } from './storage/disk-space.js';
import { WorkspaceManager } from './storage/workspace.js';
import { registerBotHandlers, BOT_COMMANDS } from './telegram/register-handlers.js';
import { TelegramMediaDownloader } from './telegram/telegram-media.js';
import { VideoDownloader } from './video/downloader.js';
import { DownloadSlots } from './video/download-slots.js';
import { VideoConverter } from './video/converter.js';
import { VideoMessageProcessor } from './video/process-message.js';
import { VideoScreenshotGenerator } from './video/screenshots.js';
import { VideoSplitter } from './video/splitter.js';

const config = loadConfig();

async function bootstrap(): Promise<void> {
  const bot = new Bot<Context>(config.botToken, {
    client: config.telegramApiRoot
      ? {
          apiRoot: config.telegramApiRoot,
        }
      : undefined,
  });

  // apiRoot must be passed along, otherwise file downloads would go to the
  // standard Bot API even when a local Bot API server is configured.
  bot.api.config.use(
    hydrateFiles(
      config.botToken,
      config.telegramApiRoot ? { apiRoot: config.telegramApiRoot } : undefined,
    ),
  );

  const workspaceManager = new WorkspaceManager(config.downloadDir);
  await workspaceManager.prepareRoot();
  workspaceManager.startAutoSweep();

  const db = new BotDatabase(config.dbPath);
  const recoveredItems = db.recoverInterruptedJobs();
  if (recoveredItems > 0) {
    console.warn(`Recovered ${recoveredItems} download item(s) interrupted by the previous shutdown.`);
  }

  // Shared across every chat: queued batches prefetch their links while another
  // chat (or an earlier message) is still sending, so the limit has to be
  // process-wide to keep the number of concurrent 4 GB+ downloads predictable.
  const downloadSlots = new DownloadSlots(config.downloadConcurrency);
  const diskGuard = new DiskSpaceGuard({
    dir: config.downloadDir,
    minFreeBytes: config.minFreeDiskBytes,
    reserveBytes: config.downloadReserveBytes,
  });

  const videoMessageProcessor = new VideoMessageProcessor({
    maxFileSizeBytes: config.maxFileSizeBytes,
    videoDownloader: new VideoDownloader({
      downloadTimeoutMs: config.downloadTimeoutMs,
      proxy: config.ytdlpProxy,
      ytdlp: new YtDlp(),
      magnetMaxFileBytes: config.magnetMaxFileBytes,
      magnetExtraTrackers: config.magnetExtraTrackers,
    }),
    videoScreenshotGenerator: new VideoScreenshotGenerator({
      commandTimeoutMs: Math.min(config.downloadTimeoutMs, 120_000),
    }),
    videoSplitter: new VideoSplitter({
      commandTimeoutMs: config.downloadTimeoutMs,
    }),
    videoConverter: new VideoConverter({
      commandTimeoutMs: config.downloadTimeoutMs,
    }),
    workspaceManager,
    screenshotCount: config.screenshotCount,
    sendVideoInAlbum: config.sendVideoInAlbum,
    reencodeAnamorphic: config.reencodeAnamorphic,
    downloadRetries: config.downloadRetries,
    downloadRetryBackoffMs: config.downloadRetryBackoffMs,
    downloadSlots,
    diskGuard,
    db,
  });

  const audioMessageProcessor = new AudioMessageProcessor({
    mediaDownloader: new TelegramMediaDownloader({
      api: bot.api,
      botToken: config.botToken,
      apiRoot: config.telegramApiRoot,
      downloadTimeoutMs: config.downloadTimeoutMs,
    }),
    audioExtractor: new AudioExtractor({
      // Audio encoding is much faster than a full video download; cap the job
      // so a broken input cannot hang for the whole download timeout.
      commandTimeoutMs: Math.min(config.downloadTimeoutMs, 900_000),
    }),
    workspaceManager,
    maxFileSizeBytes: config.maxFileSizeBytes,
  });

  registerBotHandlers(bot, videoMessageProcessor, db, audioMessageProcessor);

  const app = createHttpApp(config.downloadDir);
  const webhookPath = `/telegram/webhook/${config.webhookSecret}`;
  const webhookHandler = webhookCallback(bot, 'express', {
    // /audio processes a whole file; the grammy default (10s) rejected it and
    // Express 4 turned the rejection into a process-killing unhandled
    // rejection. Returning on timeout stops Telegram retries.
    timeoutMilliseconds: 60_000,
    onTimeout: 'return',
    secretToken: config.webhookSecretToken,
  });

  app.use(webhookPath, (req, res, next) => {
    // Express 4 does not catch rejected async handlers, so keep the rejection
    // inside this route instead of letting it crash the process.
    void webhookHandler(req, res).catch((error) => {
      console.error(`Webhook error on ${webhookPath}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ ok: false });
      }
    });
  });

  // Final safety net for any route added later.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled HTTP error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false });
    }
  });

  const server = app.listen(config.port, async () => {
    console.log(`HTTP server listening on :${config.port}`);

    const webhookUrl = buildWebhookUrl(config.publicBaseUrl, webhookPath);

    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
      secret_token: config.webhookSecretToken,
    });

    await configureBotCommands(bot);

    console.log(`Webhook set to ${webhookUrl}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    server.close(async () => {
      try {
        await bot.api.deleteWebhook({ drop_pending_updates: false });
      } catch (error) {
        console.error('Failed to delete webhook:', error);
      }

      db.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function buildWebhookUrl(publicBaseUrl: string, webhookPath: string): string {
  return new URL(webhookPath, `${publicBaseUrl.replace(/\/+$/, '')}/`).toString();
}

async function configureBotCommands(bot: Bot<Context>): Promise<void> {
  try {
    await bot.api.setMyCommands(BOT_COMMANDS);

    await bot.api.setMyDescription(
      'Bot pengunduh video. Kirim link video (YouTube, TikTok, dsb.) sebagai pesan biasa, dan bot akan mengirimkannya kembali sebagai video yang bisa di-stream langsung di Telegram.',
    );

    await bot.api.setMyShortDescription('Unduh video dari link dan kirim balik sebagai video streamable di Telegram.');
    console.log('Bot commands & description configured');
  } catch (error) {
    console.error('Failed to configure bot commands/description:', error);
  }
}

// A single failed update must not take the bot down: log it and keep serving
// the other chats. Uncaught exceptions still terminate (unknown state).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

void bootstrap();
