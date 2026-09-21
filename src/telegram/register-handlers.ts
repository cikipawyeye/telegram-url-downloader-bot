import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { BotDatabase } from '../storage/database.js';
import { TelegramNotifier } from './notifier.js';
import type { VideoMessageProcessor } from '../video/process-message.js';

export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Mulai dan lihat petunjuk singkat' },
  { command: 'help', description: 'Cara menggunakan bot' },
  { command: 'convert', description: 'Unduh & ubah ukuran video ke resolusi tertentu' },
  { command: 'noproxy', description: 'Unduh link tanpa proxy (koneksi langsung)' },
];

export const CONVERT_RESOLUTIONS = [1080, 720, 480, 240] as const;

const HELP_TEXT = [
  'Cara menggunakan bot ini:',
  '',
  '1. Kirimkan link video (YouTube, TikTok, dsb.) sebagai pesan biasa.',
  '2. Untuk bulk download, kirim beberapa link dalam satu pesan (maksimal 10 link).',
  '3. Bot akan mengunduh videonya lalu mengirimkannya kembali sebagai video yang bisa di-stream langsung di Telegram.',
  '',
  'Untuk mengubah ukuran video, gunakan /convert lalu pilih resolusi yang diinginkan (1080p, 720p, 480p, atau 240p), lalu kirimkan link videonya.',
  '',
  'Kalau link gagal gara-gara proxinya, lewati proxy untuk link tersebut:',
  '- tulis penanda noproxy di pesan, mis. "noproxy <link>" atau "tanpa proxy <link>"',
  '- penanda di barisnya sendiri berlaku untuk link-link di baris berikutnya',
  '- atau pakai /noproxy <link> untuk memaksa semua link di pesan itu tanpa proxy',
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

export function registerBotHandlers(
  bot: Bot<Context>,
  videoMessageProcessor: VideoMessageProcessor,
  db: BotDatabase,
): void {
  bot.command('start', async (ctx) => {
    db.touchUser(ctx.from ?? {});
    db.touchChat(ctx.chat ?? {});

    await ctx.reply(
      [
        'Kirim link video ke bot ini.',
        '',
        'Bot akan mencoba mengunduh video dari URL tersebut lalu mengirimkannya kembali sebagai video streamable di Telegram.',
        '',
        'Gunakan /convert untuk mengubah ukuran video ke resolusi tertentu.',
        'Gunakan /noproxy untuk mengunduh link tanpa melewati proxy.',
        '',
        'Ketik /help untuk instruksi lengkap.',
      ].join('\n'),
    );
  });

  bot.command('help', async (ctx) => {
    db.touchUser(ctx.from ?? {});
    db.touchChat(ctx.chat ?? {});

    await ctx.reply(HELP_TEXT);
  });

  bot.command('convert', async (ctx) => {
    db.touchUser(ctx.from ?? {});
    db.touchChat(ctx.chat ?? {});

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
      // Record the request even when the in-memory entry is gone (e.g. after a
      // restart) so the job row reflects what the user asked for.
      db.requestCancelByStatusMessage(statusMessageId);
      await ctx.answerCallbackQuery(cancelled ? 'Menghentikan unduhan...' : 'Tidak ada proses yang sedang berjalan.');
      return;
    }

    const resolutionMatch = data.match(/^convert:(\d+)$/);

    if (resolutionMatch) {
      const height = Number(resolutionMatch[1]);
      const chatId = ctx.chat?.id;
      const messageId = ctx.callbackQuery.message?.message_id;

      if (chatId !== undefined && messageId !== undefined) {
        db.setPendingConversion(chatId, messageId, height);
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
        db.deletePendingConversion(chatId);
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
        db.deletePendingConversion(chatId);
      }

      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        'Konversi dibatalkan. Kirim link video biasa untuk mengunduh tanpa mengubah ukuran.',
      );
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // Shared by plain messages and /noproxy: records the user/chat, consumes a
  // pending /convert selection and hands the links over to the processor.
  const handleVideoMessage = async (ctx: Context, text: string, noProxy = false): Promise<void> => {
    db.touchUser(ctx.from ?? {});
    db.touchChat(ctx.chat ?? {});

    const chatId = ctx.chat?.id;
    const pending = chatId !== undefined ? db.getPendingConversion(chatId) : undefined;
    const hasUrl = URL_PATTERN.test(text);

    if (pending && hasUrl && chatId !== undefined) {
      // Consume the pending conversion and remove the instruction message's
      // inline buttons ("Batal" / "Pilih resolusi lain").
      db.deletePendingConversion(chatId);

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
      text,
      userId: String(ctx.from?.id ?? 'unknown'),
      convertToHeight: pending?.height,
      noProxy,
    });
  };

  // Registered before the generic text handler so /noproxy is not handled twice.
  // Without arguments the processor replies with a usage hint.
  bot.command('noproxy', async (ctx) => {
    await handleVideoMessage(ctx, ctx.match, true);
  });

  bot.on('message:text', async (ctx) => {
    await handleVideoMessage(ctx, ctx.message.text);
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });
}
