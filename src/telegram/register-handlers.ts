import { InlineKeyboard, type Bot, type Context } from 'grammy';
import { TelegramNotifier } from './notifier.js';
import type { VideoMessageProcessor } from '../video/process-message.js';

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Mulai dan lihat petunjuk singkat' },
  { command: 'help', description: 'Cara menggunakan bot' },
  { command: 'convert', description: 'Unduh & ubah ukuran video ke resolusi tertentu' },
];

export const CONVERT_RESOLUTIONS = [1080, 720, 480, 240] as const;

const HELP_TEXT = [
  'Cara menggunakan bot ini:',
  '',
  '1. Kirimkan link video (YouTube, TikTok, dsb.) sebagai pesan biasa.',
  '2. Bot akan mengunduh videonya lalu mengirimkannya kembali sebagai video yang bisa di-stream langsung di Telegram.',
  '',
  'Untuk mengubah ukuran video, gunakan /convert lalu pilih resolusi yang diinginkan (1080p, 720p, 480p, atau 240p), lalu kirimkan link videonya.',
  '',
  'Catatan: video yang dikirim dalam satu album (media group) akan dikompres Telegram.',
].join('\n');

const URL_PATTERN = /https?:\/\/\S+/i;

// In-memory pending conversion resolution per chat. The chosen resolution is
// consumed by the next text message that contains a URL.
const pendingConversions = new Map<number, number>();

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
        'Gunakan /convert untuk mengubah ukuran video ke resolusi tertentu.',
        '',
        'Ketik /help untuk instruksi lengkap.',
      ].join('\n'),
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command('convert', async (ctx) => {
    const keyboard = new InlineKeyboard()
      .text('1080p', 'convert:1080')
      .text('720p', 'convert:720')
      .row()
      .text('480p', 'convert:480')
      .text('240p', 'convert:240');

    await ctx.reply(
      [
        'Pilih resolusi video yang diinginkan.',
        '',
        'Setelah memilih, kirimkan link video yang ingin diunduh lalu dikonversi ke resolusi tersebut.',
        'Video akan dikonversi agar ukurannya lebih kecil dan kompatibel untuk streaming langsung di Telegram.',
      ].join('\n'),
      { reply_markup: keyboard },
    );
  });

  bot.on('callback_query:data', async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^convert:(\d+)$/);

    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }

    const height = Number(match[1]);
    const chatId = ctx.chat?.id;

    if (chatId !== undefined) {
      pendingConversions.set(chatId, height);
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Siap! Kirimkan link video yang ingin dikonversi ke resolusi ${height}p.`,
    );
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id;
    const pendingHeight = chatId !== undefined ? pendingConversions.get(chatId) : undefined;
    const hasUrl = URL_PATTERN.test(ctx.message.text);

    await videoMessageProcessor.process({
      notifier: new TelegramNotifier(ctx, bot),
      text: ctx.message.text,
      userId: String(ctx.from?.id ?? 'unknown'),
      convertToHeight: pendingHeight,
    });

    if (hasUrl && chatId !== undefined) {
      pendingConversions.delete(chatId);
    }
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });
}
