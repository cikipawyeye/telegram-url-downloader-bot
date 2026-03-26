import 'dotenv/config';
import express from 'express';
import { Bot, webhookCallback, InputFile } from 'grammy';
import { hydrateFiles } from '@grammyjs/files';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type AppConfig = {
  port: number;
  botToken: string;
  publicBaseUrl: string;
  webhookSecret: string;
  telegramApiRoot?: string;
  downloadDir: string;
  maxFileSizeBytes: number;
  downloadTimeoutMs: number;
};

type DownloadResult = {
  filePath: string;
  fileSize: number;
  title: string;
};

const config = loadConfig();

async function bootstrap(): Promise<void> {
  await ensureDir(config.downloadDir);

  const bot = new Bot(config.botToken, {
    client: config.telegramApiRoot
      ? {
        apiRoot: config.telegramApiRoot,
      }
      : undefined,
  });

  bot.api.config.use(hydrateFiles(config.botToken));

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      downloadDir: config.downloadDir,
    });
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        'Kirim link video ke bot ini.',
        '',
        'Bot akan mencoba mengunduh video dari URL tersebut lalu mengirimkannya kembali sebagai video streamable di Telegram.',
      ].join('\n'),
    );
  });

  bot.on('message:text', async (ctx) => {
    const rawText = ctx.message.text.trim();
    const url = extractFirstUrl(rawText);

    if (!url) {
      await ctx.reply('Kirim URL yang valid.');
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id ?? 'unknown';
    const jobId = `${Date.now()}-${userId}-${crypto.randomUUID()}`;
    const jobDir = path.join(config.downloadDir, jobId);

    await ensureDir(jobDir);

    // Balas cepat supaya webhook selesai
    const responseMessage = await ctx.reply('Link diterima. Sedang mencoba mendownload video...');

    // Proses berat dijalankan di background
    void (async () => {
      try {
        const result = await downloadVideo(url, jobDir);

        if (result.fileSize > config.maxFileSizeBytes) {
          bot.api.editMessageText(chatId, responseMessage.message_id, `Video berhasil didownload, tetapi ukurannya melebihi batas server (${formatBytes(config.maxFileSizeBytes)}).`);

          return;
        }

        await bot.api.editMessageText(
          chatId, responseMessage.message_id, 'Download selesai. Sedang mengirim video ke Telegram...'
        );

        const fileName = sanitizeFileName(path.basename(result.filePath));

        await bot.api.sendVideo(
          chatId,
          new InputFile(result.filePath, fileName),
          {
            supports_streaming: true,
            caption: truncateCaption(result.title),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Terjadi error.';
        await bot.api.editMessageText(chatId, responseMessage.message_id, `Gagal memproses link.\n${message}`);
      } finally {
        await safeRemoveDir(jobDir);
      }
    })();
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });

  const webhookPath = `/telegram/webhook/${config.webhookSecret}`;
  app.use(webhookPath, webhookCallback(bot, 'express'));

  const server = app.listen(config.port, async () => {
    console.log(`HTTP server listening on :${config.port}`);

    const webhookUrl = `${stripTrailingSlash(config.publicBaseUrl)}${webhookPath}`;

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

function loadConfig(): AppConfig {
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
  };
}

async function downloadVideo(url: string, outputDir: string): Promise<DownloadResult> {
  const outputTemplate = path.join(outputDir, '%(title).120s [%(id)s].%(ext)s');

  const metadata = await runCommandJson('yt-dlp', [
    '--dump-single-json',
    '--no-playlist',
    url,
  ]);

  const title = typeof metadata.title === 'string' ? metadata.title : 'video';
  const extractorError = metadata._type === 'error' ? metadata.error : undefined;

  if (extractorError) {
    throw new Error(String(extractorError));
  }

  await runCommand('yt-dlp', [
    '--no-playlist',
    '--merge-output-format',
    'mp4',
    '-o',
    outputTemplate,
    url,
  ], config.downloadTimeoutMs);

  const files = await fsp.readdir(outputDir);
  const candidates = files
    .filter((file) => !file.endsWith('.part'))
    .map((file) => path.join(outputDir, file));

  if (candidates.length === 0) {
    throw new Error('File hasil download tidak ditemukan.');
  }

  let bestFile = candidates[0];
  let bestStat = await fsp.stat(bestFile);

  for (const file of candidates.slice(1)) {
    const stat = await fsp.stat(file);
    if (stat.size > bestStat.size) {
      bestFile = file;
      bestStat = stat;
    }
  }

  return {
    filePath: bestFile,
    fileSize: bestStat.size,
    title,
  };
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Proses download timeout setelah ${Math.round(timeoutMs / 1000)} detik.`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
      reject(new Error(output || `${command} exited with code ${code}`));
    });
  });
}

async function runCommandJson(command: string, args: string[]): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    await fsp.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed to remove temp dir ${dirPath}:`, error);
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function truncateCaption(title: string, maxLength = 900): string {
  if (title.length <= maxLength) {
    return title;
  }
  return `${title.slice(0, maxLength - 1)}…`;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

void bootstrap();
