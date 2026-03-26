import { InputFile, type Bot, type Context } from 'grammy';
import type { OutboundScreenshot, OutboundVideo, StatusMessage, VideoRequestNotifier } from '../../application/ports/video-request-notifier.js';

export class GrammyVideoRequestNotifier implements VideoRequestNotifier {
  private readonly bot: Bot<Context>;
  private readonly ctx: Context;
  private readonly minProgressUpdateIntervalMs = 1500;
  private lastStatusText: string | null = null;
  private lastProgressUpdateAt = 0;
  private pendingProgressTimer: NodeJS.Timeout | null = null;
  private pendingProgressText: string | null = null;
  private statusUpdateChain: Promise<void> = Promise.resolve();

  constructor(ctx: Context, bot: Bot<Context>) {
    this.ctx = ctx;
    this.bot = bot;
  }

  async sendInvalidUrl(): Promise<void> {
    await this.ctx.reply('Kirim URL yang valid ya.');
  }

  async sendAccepted(): Promise<StatusMessage> {
    const message = await this.ctx.reply('Link diterima. Sedang mencoba mendownload video...');
    this.lastStatusText = message.text;
    return { messageId: message.message_id };
  }

  async updateStatus(statusMessage: StatusMessage, text: string): Promise<void> {
    this.clearPendingProgress();
    await this.enqueueStatusUpdate(statusMessage, text);
  }

  async updateProgress(statusMessage: StatusMessage, text: string): Promise<void> {
    if (text === this.lastStatusText || text === this.pendingProgressText) {
      return;
    }

    this.pendingProgressText = text;

    if (this.pendingProgressTimer) {
      return;
    }

    const waitMs = Math.max(0, this.minProgressUpdateIntervalMs - (Date.now() - this.lastProgressUpdateAt));

    this.pendingProgressTimer = setTimeout(() => {
      this.pendingProgressTimer = null;
      void this.flushPendingProgress(statusMessage);
    }, waitMs);
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

  async sendScreenshots(screenshots: OutboundScreenshot[]): Promise<void> {
    const media = screenshots.map((screenshot) => ({
      type: 'photo' as const,
      media: new InputFile(screenshot.filePath, screenshot.fileName),
      caption: screenshot.caption,
    }));

    await this.bot.api.sendMediaGroup(this.getChatId(), media);
  }

  private getChatId(): number {
    const chatId = this.ctx.chat?.id;

    if (chatId === undefined) {
      throw new Error('Chat id is unavailable for this update.');
    }

    return chatId;
  }

  private async flushPendingProgress(statusMessage: StatusMessage): Promise<void> {
    const text = this.pendingProgressText;
    this.pendingProgressText = null;

    if (!text) {
      return;
    }

    await this.enqueueStatusUpdate(statusMessage, text);
  }

  private clearPendingProgress(): void {
    this.pendingProgressText = null;

    if (!this.pendingProgressTimer) {
      return;
    }

    clearTimeout(this.pendingProgressTimer);
    this.pendingProgressTimer = null;
  }

  private async enqueueStatusUpdate(statusMessage: StatusMessage, text: string): Promise<void> {
    if (text === this.lastStatusText) {
      return;
    }

    this.statusUpdateChain = this.statusUpdateChain
      .catch(() => undefined)
      .then(async () => {
        if (text === this.lastStatusText) {
          return;
        }

        try {
          await this.bot.api.editMessageText(this.getChatId(), statusMessage.messageId, text);
        } catch (error) {
          if (!isMessageNotModifiedError(error)) {
            throw error;
          }
        }

        this.lastStatusText = text;
        this.lastProgressUpdateAt = Date.now();
      });

    await this.statusUpdateChain;
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('message is not modified');
}
