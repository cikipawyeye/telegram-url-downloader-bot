import type { Bot, Context } from 'grammy';
import type { ProcessVideoMessageUseCase } from '../../application/use-cases/process-video-message.js';
import { GrammyVideoRequestNotifier } from './grammy-video-request-notifier.js';

export function registerBotHandlers(
  bot: Bot<Context>,
  processVideoMessage: ProcessVideoMessageUseCase,
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
    await processVideoMessage.execute({
      notifier: new GrammyVideoRequestNotifier(ctx, bot),
      text: ctx.message.text,
      userId: String(ctx.from?.id ?? 'unknown'),
    });
  });

  bot.catch(async (error) => {
    console.error('Bot error:', error.error);
  });
}
