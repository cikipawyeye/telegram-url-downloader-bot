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
  private static readonly mediaSendQueues = new Map<number, Promise<void>>();
  private readonly bot: Bot<Context>;
  private readonly ctx: Context;
  private readonly replyToMessageId?: number;
  private readonly minProgressUpdateIntervalMs = 1500;
  private lastStatusText: string | null = null;
  private lastProgressUpdateAt = 0;
  private pendingProgressTimer: NodeJS.Timeout | null = null;
  private pendingProgressText: string | null = null;
  private statusMessageClosed = false;
  private statusUpdateChain: Promise<void> = Promise.resolve();
  private stopButtonActive = false;
  private stopButtonCallbackData: string | null = null;

  constructor(ctx: Context, bot: Bot<Context>) {
    this.ctx = ctx;
    this.bot = bot;
    this.replyToMessageId = ctx.message?.message_id;
  }

  /** Chat the notifier is bound to; needed for job bookkeeping. */
  get chatId(): number {
    return this.getChatId();
  }

  async sendInvalidUrl(): Promise<void> {
    await this.ctx.reply('Kirim URL yang valid ya.', { reply_parameters: this.replyParameters() });
  }

  async sendBatchLimit(max: number): Promise<void> {
    await this.ctx.reply(`Maksimal ${max} URL per pesan.`, { reply_parameters: this.replyParameters() });
  }

  async sendAccepted(): Promise<StatusMessage> {
    const message = await this.ctx.reply('Link diterima. Sedang mencoba mendownload video...', {
      reply_parameters: this.replyParameters(),
    });
    this.lastStatusText = message.text;
    this.statusMessageClosed = false;
    this.stopButtonActive = false;
    this.stopButtonCallbackData = null;
    return { messageId: message.message_id };
  }

  async addDownloadStopButton(statusMessage: StatusMessage, callbackData: string): Promise<void> {
    this.stopButtonActive = true;
    this.stopButtonCallbackData = callbackData;
    await this.editStatusText(statusMessage.messageId, this.lastStatusText ?? '', this.buildStatusKeyboard());
  }

  async removeDownloadStopButton(statusMessage: StatusMessage): Promise<void> {
    this.stopButtonActive = false;
    this.stopButtonCallbackData = null;
    await this.editStatusText(statusMessage.messageId, this.lastStatusText ?? '', this.buildStatusKeyboard());
  }

  async confirmStopped(statusMessage: StatusMessage): Promise<void> {
    this.clearPendingProgress();
    this.statusMessageClosed = true;
    this.stopButtonActive = false;
    this.stopButtonCallbackData = null;
    await this.editStatusText(statusMessage.messageId, 'Unduhan dihentikan.', new InlineKeyboard());
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

  async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
    const chatId = this.getChatId();
    const previous = TelegramNotifier.mediaSendQueues.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const queueEntry = current.then(() => undefined, () => undefined);
    TelegramNotifier.mediaSendQueues.set(chatId, queueEntry);

    try {
      return await current;
    } finally {
      if (TelegramNotifier.mediaSendQueues.get(chatId) === queueEntry) {
        TelegramNotifier.mediaSendQueues.delete(chatId);
      }
    }
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
    this.stopButtonActive = false;
    this.stopButtonCallbackData = null;

    this.statusUpdateChain = this.statusUpdateChain
      .catch(() => undefined)
      .then(async () => {
        await this.bot.api.deleteMessage(this.getChatId(), statusMessage.messageId);
        this.lastStatusText = null;
        this.lastProgressUpdateAt = 0;
      });

    await this.statusUpdateChain;
  }

  private buildStatusKeyboard(): InlineKeyboard {
    if (!this.stopButtonActive || !this.stopButtonCallbackData) {
      return new InlineKeyboard();
    }

    return new InlineKeyboard().text('⏹ Hentikan Unduhan', this.stopButtonCallbackData);
  }

  private async editStatusMessage(messageId: number, text: string): Promise<void> {
    try {
      await this.bot.api.editMessageText(this.getChatId(), messageId, text, {
        reply_markup: this.buildStatusKeyboard(),
      });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
  }

  private async editStatusText(messageId: number, text: string, replyMarkup: InlineKeyboard): Promise<void> {
    try {
      await this.bot.api.editMessageText(this.getChatId(), messageId, text, { reply_markup: replyMarkup });
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
  }

  private getChatId(): number {
    const chatId = this.ctx.chat?.id;

    if (chatId === undefined) {
      throw new Error('Chat id is unavailable for this update.');
    }

    return chatId;
  }

  private replyParameters(): { message_id: number } | undefined {
    return this.replyToMessageId === undefined ? undefined : { message_id: this.replyToMessageId };
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
          await this.editStatusMessage(statusMessage.messageId, text);
        } catch (error) {
          // Status text is cosmetic; never fail the whole batch over it.
          console.error('Failed to update status message:', error);
          return;
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
