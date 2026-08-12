import { InlineKeyboard, InputFile, type Bot, type Context } from 'grammy';
import type { VideoScreenshot, VideoThumbnail } from '../video/utils.js';

export type StatusMessage = {
  messageId: number;
};

export type OutboundVideo = {
  filePath: string;
  fileName: string;
  caption: string;
  thumbnail?: VideoThumbnail;
  width?: number;
  height?: number;
};

const MEDIA_GROUP_MAX_ITEMS = 10;

export class TelegramNotifier {
  private readonly bot: Bot<Context>;
  private readonly ctx: Context;
  private readonly minProgressUpdateIntervalMs = 1500;
  private lastStatusText: string | null = null;
  private lastProgressUpdateAt = 0;
  private pendingProgressTimer: NodeJS.Timeout | null = null;
  private pendingProgressText: string | null = null;
  private statusMessageClosed = false;
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
    this.statusMessageClosed = false;
    return { messageId: message.message_id };
  }

  async addDownloadStopButton(statusMessage: StatusMessage, callbackData: string): Promise<void> {
    const keyboard = new InlineKeyboard().text('⏹ Hentikan Unduhan', callbackData);
    await this.bot.api.editMessageText(
      this.getChatId(),
      statusMessage.messageId,
      this.lastStatusText ?? '',
      { reply_markup: keyboard },
    );
  }

  async removeDownloadStopButton(statusMessage: StatusMessage): Promise<void> {
    await this.bot.api.editMessageText(
      this.getChatId(),
      statusMessage.messageId,
      this.lastStatusText ?? '',
      { reply_markup: new InlineKeyboard() },
    );
  }

  async confirmStopped(statusMessage: StatusMessage): Promise<void> {
    this.clearPendingProgress();
    this.statusMessageClosed = true;
    await this.bot.api.editMessageText(this.getChatId(), statusMessage.messageId, 'Unduhan dihentikan.', {
      reply_markup: new InlineKeyboard(),
    });
  }

  async updateStatus(statusMessage: StatusMessage, text: string): Promise<void> {
    if (this.statusMessageClosed) {
      return;
    }

    this.clearPendingProgress();
    await this.enqueueStatusUpdate(statusMessage, text);
  }

  async updateProgress(statusMessage: StatusMessage, text: string): Promise<void> {
    if (this.statusMessageClosed) {
      return;
    }

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

  async sendScreenshots(screenshots: VideoScreenshot[]): Promise<void> {
    const media = screenshots.map((screenshot) => ({
      type: 'photo' as const,
      media: new InputFile(screenshot.filePath, screenshot.fileName),
    }));

    await this.bot.api.sendMediaGroup(this.getChatId(), media);
  }

  async sendVideoWithScreenshots(screenshots: VideoScreenshot[], video: OutboundVideo): Promise<void> {
    const media: Array<
      | { type: 'photo'; media: InputFile }
      | {
          type: 'video';
          media: InputFile;
          caption: string;
          width?: number;
          height?: number;
          supports_streaming: boolean;
        }
    > = [
      {
        type: 'video',
        media: new InputFile(video.filePath, video.fileName),
        caption: video.caption,
        width: video.width,
        height: video.height,
        supports_streaming: true,
      },
      ...screenshots.map((screenshot) => ({
        type: 'photo' as const,
        media: new InputFile(screenshot.filePath, screenshot.fileName),
      })),
    ];

    await this.bot.api.sendMediaGroup(this.getChatId(), media);
  }

  canCombineScreenshotsWithVideo(screenshotsCount: number): boolean {
    return screenshotsCount > 0 && screenshotsCount + 1 <= MEDIA_GROUP_MAX_ITEMS;
  }

  async sendVideo(video: OutboundVideo): Promise<void> {
    await this.bot.api.sendVideo(
      this.getChatId(),
      new InputFile(video.filePath, video.fileName),
      {
        supports_streaming: true,
        caption: video.caption,
        width: video.width,
        height: video.height,
        thumbnail: video.thumbnail
          ? new InputFile(video.thumbnail.filePath, video.thumbnail.fileName)
          : undefined,
      },
    );
  }

  async deleteStatus(statusMessage: StatusMessage): Promise<void> {
    this.clearPendingProgress();
    this.statusMessageClosed = true;

    this.statusUpdateChain = this.statusUpdateChain
      .catch(() => undefined)
      .then(async () => {
        await this.bot.api.deleteMessage(this.getChatId(), statusMessage.messageId);
        this.lastStatusText = null;
        this.lastProgressUpdateAt = 0;
      });

    await this.statusUpdateChain;
  }

  private getChatId(): number {
    const chatId = this.ctx.chat?.id;

    if (chatId === undefined) {
      throw new Error('Chat id is unavailable for this update.');
    }

    return chatId;
  }

  private async flushPendingProgress(statusMessage: StatusMessage): Promise<void> {
    if (this.statusMessageClosed) {
      this.pendingProgressText = null;
      return;
    }

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
    if (this.statusMessageClosed || text === this.lastStatusText) {
      return;
    }

    this.statusUpdateChain = this.statusUpdateChain
      .catch(() => undefined)
      .then(async () => {
        if (this.statusMessageClosed || text === this.lastStatusText) {
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
