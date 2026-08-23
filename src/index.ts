import 'dotenv/config';
import { hydrateFiles } from '@grammyjs/files';
import { Bot, type Context, webhookCallback } from 'grammy';
import { YtDlp } from 'ytdlp-nodejs';
import { loadConfig } from './config.js';
import { createHttpApp } from './http/create-app.js';
import { BotDatabase } from './storage/database.js';
import { WorkspaceManager } from './storage/workspace.js';
import { registerBotHandlers, BOT_COMMANDS } from './telegram/register-handlers.js';
import { VideoDownloader } from './video/downloader.js';
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

  bot.api.config.use(hydrateFiles(config.botToken));

  const workspaceManager = new WorkspaceManager(config.downloadDir);
  await workspaceManager.prepareRoot();
  workspaceManager.startAutoSweep();

  const db = new BotDatabase(config.dbPath);

  const videoMessageProcessor = new VideoMessageProcessor({
    maxFileSizeBytes: config.maxFileSizeBytes,
    videoDownloader: new VideoDownloader({
      downloadTimeoutMs: config.downloadTimeoutMs,
      proxy: config.ytdlpProxy,
      ytdlp: new YtDlp(),
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
    db,
  });

  registerBotHandlers(bot, videoMessageProcessor, db);

  const app = createHttpApp(config.downloadDir);
  const webhookPath = `/telegram/webhook/${config.webhookSecret}`;

  app.use(webhookPath, webhookCallback(bot, 'express'));

  const server = app.listen(config.port, async () => {
    console.log(`HTTP server listening on :${config.port}`);

    const webhookUrl = buildWebhookUrl(config.publicBaseUrl, webhookPath);

    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query'],
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

void bootstrap();
