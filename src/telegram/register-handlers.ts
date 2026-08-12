import type { Bot, Context } from 'grammy';
import { TelegramNotifier } from './notifier.js';
import type { VideoMessageProcessor } from '../video/process-message.js';

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Mulai dan lihat petunjuk singkat' },
  { command: 'help', description: 'Cara menggunakan bot' },
];

const HELP_TEXT = [
  'Cara menggunakan bot ini:',
  '',
  '1. Kirimkan link video (YouTube, TikTok, dsb.) sebagai pesan biasa.',
  '2. Bot akan mengunduh videonya lalu mengirimkannya kembali sebagai video yang bisa di-stream langsung di Telegram.',
  '',
  'Catatan: video yang dikirim dalam satu album (media group) akan dikompres Telegram.',
].join('\n');

export function registerBotHandlers(
  bot: Bot<Context>,
  videoMessageProcessor: VideoMessageProcessor,
): void {
  bot.command('start', async (ctx) => {
    await ctx.reply(
      [
        'Kirim link video ke bot ini.',
        '',
        'Bot akan mencoba mengunduh video dari URL tersebut lalu mengirimkannya kembali sebagai video streamable di Telegram.',
        '',
        'Ketik /help untuk instruksi lengkap.',
      ].join('\n'),
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.on('message:text', async (ctx) => {
    await videoMessageProcessor.process({
      notifier: new TelegramNotifier(ctx, bot),
      text: ctx.message.text,
      userId: String(ctx.from?.id ?? 'unknown'),
    });
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });
}
