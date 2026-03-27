import 'dotenv/config';
import { hydrateFiles } from '@grammyjs/files';
import { Bot, type Context, webhookCallback } from 'grammy';
import { YtDlp } from 'ytdlp-nodejs';
import { loadConfig } from './config.js';
import { createHttpApp } from './http/create-app.js';
import { WorkspaceManager } from './storage/workspace.js';
import { registerBotHandlers } from './telegram/register-handlers.js';
import { VideoDownloader } from './video/downloader.js';
import { VideoMessageProcessor } from './video/process-message.js';
import { VideoScreenshotGenerator } from './video/screenshots.js';

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

  const videoMessageProcessor = new VideoMessageProcessor({
    maxFileSizeBytes: config.maxFileSizeBytes,
    videoDownloader: new VideoDownloader({
      downloadTimeoutMs: config.downloadTimeoutMs,
      ytdlp: new YtDlp(),
    }),
    videoScreenshotGenerator: new VideoScreenshotGenerator({
      commandTimeoutMs: Math.min(config.downloadTimeoutMs, 120_000),
    }),
    workspaceManager,
  });

  registerBotHandlers(bot, videoMessageProcessor);

  const app = createHttpApp(config.downloadDir);
  const webhookPath = `/telegram/webhook/${config.webhookSecret}`;

  app.use(webhookPath, webhookCallback(bot, 'express'));

  const server = app.listen(config.port, async () => {
    console.log(`HTTP server listening on :${config.port}`);

    const webhookUrl = buildWebhookUrl(config.publicBaseUrl, webhookPath);

    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
      allowed_updates: ['message'],
    });

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

      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function buildWebhookUrl(publicBaseUrl: string, webhookPath: string): string {
  return new URL(webhookPath, `${publicBaseUrl.replace(/\/+$/, '')}/`).toString();
}

void bootstrap();
