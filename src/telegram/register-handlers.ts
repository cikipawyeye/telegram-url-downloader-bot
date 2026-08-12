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

const RESOLUTION_MENU_TEXT = [
  'Pilih resolusi video yang diinginkan.',
  '',
  'Setelah memilih, kirimkan link video yang ingin diunduh lalu dikonversi ke resolusi tersebut.',
  'Video akan dikonversi agar ukurannya lebih kecil dan kompatibel untuk streaming langsung di Telegram.',
].join('\n');

function buildResolutionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('1080p', 'convert:1080')
    .text('720p', 'convert:720')
    .row()
    .text('480p', 'convert:480')
    .text('240p', 'convert:240');
}

function buildPendingKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Pilih resolusi lain', 'convert:select')
    .row()
    .text('❌ Batal', 'convert:cancel');
}

type PendingConversion = {
  height: number;
  messageId: number;
};

// In-memory pending conversion per chat, along with the id of the instruction
// message so its inline buttons can be removed once a URL is sent.
const pendingConversions = new Map<number, PendingConversion>();

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
    await ctx.reply(RESOLUTION_MENU_TEXT, {
      reply_markup: buildResolutionKeyboard(),
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    const stopMatch = data.match(/^stop:download:(\d+)$/);
    if (stopMatch) {
      const statusMessageId = Number(stopMatch[1]);
      const cancelled = videoMessageProcessor.cancelDownload(statusMessageId);
      await ctx.answerCallbackQuery(cancelled ? 'Menghentikan unduhan...' : 'Tidak ada proses yang sedang berjalan.');
      return;
    }

    const resolutionMatch = data.match(/^convert:(\d+)$/);

    if (resolutionMatch) {
      const height = Number(resolutionMatch[1]);
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery.message?.message_id;

      if (chatId !== undefined && messageId !== undefined) {
        pendingConversions.set(chatId, { height, messageId });
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        [
          `Siap! Resolusi ${height}p terpilih.`,
          '',
          `Kirimkan link video yang ingin dikonversi ke resolusi ${height}p.`,
        ].join('\n'),
        { reply_markup: buildPendingKeyboard() },
      );
      return;
    }

    if (data === 'convert:select') {
      const chatId = ctx.chat?.id;

      if (chatId !== undefined) {
        pendingConversions.delete(chatId);
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(RESOLUTION_MENU_TEXT, {
        reply_markup: buildResolutionKeyboard(),
      });
      return;
    }

    if (data === 'convert:cancel') {
      const chatId = ctx.chat?.id;

      if (chatId !== undefined) {
        pendingConversions.delete(chatId);
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        'Konversi dibatalkan. Kirim link video biasa untuk mengunduh tanpa mengubah ukuran.',
      );
      return;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id;
    const pending = chatId !== undefined ? pendingConversions.get(chatId) : undefined;
    const hasUrl = URL_PATTERN.test(ctx.message.text);

    if (pending && hasUrl && chatId !== undefined) {
      // Consume the pending conversion and remove the instruction message's
      // inline buttons ("Batal" / "Pilih resolusi lain").
      pendingConversions.delete(chatId);

      try {
        await ctx.api.editMessageText(
          chatId,
          pending.messageId,
          `✓ Resolusi ${pending.height}p diaktifkan untuk pengunduhan ini.`,
        );
      } catch (error) {
        console.error('Failed to clear convert instruction buttons:', error);
      }
    }

    await videoMessageProcessor.process({
      notifier: new TelegramNotifier(ctx, bot),
      text: ctx.message.text,
      userId: String(ctx.from?.id ?? 'unknown'),
      convertToHeight: pending?.height,
    });
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });
}
