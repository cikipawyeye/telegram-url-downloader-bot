import type { Bot, Context } from 'grammy';
import { TelegramNotifier } from './notifier.js';
import type { VideoMessageProcessor } from '../video/process-message.js';

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
      ].join('\n'),
    );
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
