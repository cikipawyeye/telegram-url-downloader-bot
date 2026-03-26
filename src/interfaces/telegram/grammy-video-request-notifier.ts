import { InputFile, type Bot, type Context } from 'grammy';
import type { OutboundVideo, StatusMessage, VideoRequestNotifier } from '../../application/ports/video-request-notifier.js';

export class GrammyVideoRequestNotifier implements VideoRequestNotifier {
  private readonly bot: Bot<Context>;
  private readonly ctx: Context;

  constructor(ctx: Context, bot: Bot<Context>) {
    this.ctx = ctx;
    this.bot = bot;
  }

  async sendInvalidUrl(): Promise<void> {
    await this.ctx.reply('Kirim URL yang valid ya.');
  }

  async sendAccepted(): Promise<StatusMessage> {
    const message = await this.ctx.reply('Link diterima. Sedang mencoba mendownload video...');
    return { messageId: message.message_id };
  }

  async updateStatus(statusMessage: StatusMessage, text: string): Promise<void> {
    await this.bot.api.editMessageText(this.getChatId(), statusMessage.messageId, text);
  }

  async sendVideo(video: OutboundVideo): Promise<void> {
    await this.bot.api.sendVideo(
      this.getChatId(),
      new InputFile(video.filePath, video.fileName),
      {
        supports_streaming: true,
        caption: video.caption,
      },
    );
  }

  private getChatId(): number {
    const chatId = this.ctx.chat?.id;

    if (chatId === undefined) {
      throw new Error('Chat id is unavailable for this update.');
    }

    return chatId;
  }
}
