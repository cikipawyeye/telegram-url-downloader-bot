import 'dotenv/config';
import { hydrateFiles } from '@grammyjs/files';
import { Bot, type Context, webhookCallback } from 'grammy';
import { ProcessVideoMessageUseCase } from './application/use-cases/process-video-message.js';
import { loadConfig } from './config/app-config.js';
import { YtDlpVideoDownloader } from './infrastructure/downloaders/yt-dlp-video-downloader.js';
import { CommandRunner } from './infrastructure/process/command-runner.js';
import { FileSystemDownloadWorkspaceStore } from './infrastructure/storage/file-system-download-workspace-store.js';
import { createHttpApp } from './interfaces/http/create-http-app.js';
import { registerBotHandlers } from './interfaces/telegram/register-bot-handlers.js';

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

  const workspaceStore = new FileSystemDownloadWorkspaceStore(config.downloadDir);
  await workspaceStore.prepareRoot();

  const processVideoMessage = new ProcessVideoMessageUseCase({
    maxFileSizeBytes: config.maxFileSizeBytes,
    videoDownloader: new YtDlpVideoDownloader({
      commandRunner: new CommandRunner(),
      downloadTimeoutMs: config.downloadTimeoutMs,
    }),
    workspaceStore,
  });

  registerBotHandlers(bot, processVideoMessage);

  const app = createHttpApp({ downloadDir: config.downloadDir });
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
