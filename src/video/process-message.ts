import type { WorkspaceManager } from '../storage/workspace.js';
import type { BotDatabase } from '../storage/database.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, buildDeliveryPartFileName, buildPartCaption, buildFailureSummary, formatBytes, formatDownloadProgress, hasNoProxyOverride, parseVideoRequestItems, summarizeErrorMessage, truncateCaption, type BatchFailure, type VideoDownloadProgress, type VideoRequestItem, type VideoThumbnail } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import { DownloadCancelledError } from './downloader.js';
import { buildPixelAspectFilter } from './screenshots.js';
import type { VideoScreenshotGenerator } from './screenshots.js';
import type { VideoSplitter } from './splitter.js';
import type { VideoConverter } from './converter.js';

export type ProcessVideoMessageRequest = {
  notifier: TelegramNotifier;
  text: string;
  userId: string;
  convertToHeight?: number;
  /** Force a direct connection (no proxy) for every URL in this message. */
  noProxy?: boolean;
};

type BatchOptions = {
  convertToHeight?: number;
  forceNoProxy: boolean;
  signal: AbortSignal;
  jobId?: number;
};

export class VideoMessageProcessor {
  /** FIFO per chat; serializes whole concurrent batches so cross-batch media order is stable. */
  private static readonly batchQueues = new Map<number, Promise<void>>();

  private readonly maxFileSizeBytes: number;
  private readonly videoDownloader: VideoDownloader;
  private readonly videoScreenshotGenerator: VideoScreenshotGenerator;
  private readonly videoSplitter: VideoSplitter;
  private readonly videoConverter: VideoConverter;
  private readonly workspaceManager: WorkspaceManager;
  private readonly db?: BotDatabase;
  private readonly screenshotCount: number;
  private readonly sendVideoInAlbum: boolean;
  private readonly reencodeAnamorphic: boolean;
  private readonly pendingCancellations = new Map<number, AbortController>();

  constructor(options: {
    maxFileSizeBytes: number;
    videoDownloader: VideoDownloader;
    videoScreenshotGenerator: VideoScreenshotGenerator;
    videoSplitter: VideoSplitter;
    videoConverter: VideoConverter;
    workspaceManager: WorkspaceManager;
    screenshotCount: number;
    sendVideoInAlbum: boolean;
    reencodeAnamorphic: boolean;
    db?: BotDatabase;
  }) {
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.videoDownloader = options.videoDownloader;
    this.videoScreenshotGenerator = options.videoScreenshotGenerator;
    this.videoSplitter = options.videoSplitter;
    this.videoConverter = options.videoConverter;
    this.workspaceManager = options.workspaceManager;
    this.screenshotCount = options.screenshotCount;
    this.sendVideoInAlbum = options.sendVideoInAlbum;
    this.reencodeAnamorphic = options.reencodeAnamorphic;
    this.db = options.db;
  }

  cancelDownload(statusMessageId: number): boolean {
    const controller = this.pendingCancellations.get(statusMessageId);

    if (!controller || controller.signal.aborted) {
      return false;
    }

    controller.abort();
    this.pendingCancellations.delete(statusMessageId);
    return true;
  }

  async process({ notifier, text, userId, convertToHeight, noProxy }: ProcessVideoMessageRequest): Promise<void> {
    const items = parseVideoRequestItems(text.trim());
    // `/noproxy` forces every link of the message, while the marker inside the
    // text only opts out the links it shares a line with (or follows).
    const forceNoProxy = noProxy === true;

    if (items.length === 0) {
      if (forceNoProxy || hasNoProxyOverride(text)) {
        await notifier.sendNoProxyHint();
      } else {
        await notifier.sendInvalidUrl();
      }
      return;
    }

    const maxBulkUrls = parseInt(process.env.MAX_BULK_URLS ?? '20', 10);
    if (items.length > maxBulkUrls) {
      await notifier.sendBatchLimit(maxBulkUrls);
      return;
    }

    try {
      const acceptedMessage = await notifier.sendAccepted();

      const controller = new AbortController();
      this.pendingCancellations.set(acceptedMessage.messageId, controller);

      const jobId = this.db?.createJob({
        chatId: notifier.chatId,
        userId: Number(userId) || undefined,
        statusMessageId: acceptedMessage.messageId,
        convertHeight: convertToHeight,
      });

      await notifier.addDownloadStopButton(
        acceptedMessage,
        `stop:download:${acceptedMessage.messageId}`,
      );

      // Catch here: a rejecting batch must never become an unhandled
      // rejection (it crashes the process and kills the stop button).
      this.enqueueBatch(
        notifier,
        acceptedMessage,
        items,
        userId,
        { convertToHeight, forceNoProxy, signal: controller.signal, jobId },
      ).catch(async (error) => {
        console.error(`Batch failed for status message ${acceptedMessage.messageId}:`, error);

        this.pendingCancellations.delete(acceptedMessage.messageId);
        if (jobId !== undefined) {
          this.db?.cancelItems(jobId);
          this.db?.finishJob(jobId, 'failed');
        }

        const reason = summarizeErrorMessage(error);
        await notifier.updateStatus(
          acceptedMessage,
          `Proses berhenti karena error. Kirim ulang link untuk melanjutkan.\n${reason}`,
        ).catch(() => undefined);
      });
    } catch (error) {
      throw error;
    }
  }

  private enqueueBatch(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    items: VideoRequestItem[],
    userId: string,
    batch: BatchOptions,
  ): Promise<void> {
    const chatId = notifier.chatId;
    const previous = VideoMessageProcessor.batchQueues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processBatch(notifier, acceptedMessage, items, userId, batch));
    // Reflect the final settled state in the map regardless of failure, so the
    // next batch for this chat is never blocked by a rejected queue entry.
    const queueEntry = current.then(
      () => undefined,
      () => undefined,
    );
    VideoMessageProcessor.batchQueues.set(chatId, queueEntry);

    return current;
  }

  private async processBatch(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    items: VideoRequestItem[],
    userId: string,
    { convertToHeight, forceNoProxy, signal, jobId }: BatchOptions,
  ): Promise<void> {
    const expandedItems: VideoRequestItem[] = [];
    const expansionFailures: BatchFailure[] = [];
    for (const item of items) {
      try {
        const expandedUrls = await this.videoDownloader.expandUrl(item.url);
        expandedItems.push(
          ...expandedUrls.map((url) => ({ url, noProxy: item.noProxy || forceNoProxy })),
        );
      } catch (error) {
        console.error(`Failed to read bulk URL ${item.url}:`, error);
        expansionFailures.push({ url: item.url, reason: summarizeErrorMessage(error) });
      }
    }

    items = expandedItems;
    if (items.length === 0) {
      this.pendingCancellations.delete(acceptedMessage.messageId);
      if (jobId !== undefined) {
        this.db?.setJobTotalUrls(jobId, 0);
        this.db?.finishJob(jobId, 'failed');
      }
      const message = expansionFailures.length > 0
        ? buildFailureSummary('Gagal membaca video dari input tersebut:', expansionFailures)
        : 'Album berhasil dibaca, tetapi tidak berisi video.';
      await notifier.updateStatus(acceptedMessage, message);
      await notifier.removeDownloadStopButton(acceptedMessage);
      this.pendingCancellations.delete(acceptedMessage.messageId);
      return;
    }

    if (jobId !== undefined) {
      this.db?.setJobTotalUrls(jobId, items.length);
    }

    const failed: BatchFailure[] = [];
    let completed = 0;

    for (const [index, item] of items.entries()) {
      if (signal.aborted) {
        await notifier.confirmStopped(acceptedMessage);
        this.pendingCancellations.delete(acceptedMessage.messageId);
        return;
      }

      const workspace = await this.workspaceManager.create(userId);
      const noProxyLabel = item.noProxy ? ' tanpa proxy' : '';
      await notifier.updateStatus(
        acceptedMessage,
        `Selesai ${completed}/${items.length}. Memproses ${index + 1}/${items.length}${noProxyLabel}...`,
      );

      let itemId: number | undefined;
      if (jobId !== undefined) {
        itemId = this.db?.addItem(jobId, item.url, { noProxy: item.noProxy });
      }

      try {
        const video = await this.videoDownloader.download({
          url: item.url,
          outputDir: workspace.dirPath,
          signal,
          noProxy: item.noProxy,
          onProgress: (progress) => {
            void this.reportDownloadProgress(notifier, acceptedMessage, progress);
          },
        });
        await this.processDownloadedVideo(notifier, acceptedMessage, workspace.dirPath, video, convertToHeight, signal);
        completed += 1;
        if (itemId !== undefined) {
          this.db?.completeItem(itemId, video);
        }
      } catch (error) {
        if (error instanceof DownloadCancelledError) {
          if (jobId !== undefined) {
            this.db?.cancelItems(jobId);
            this.db?.finishJob(jobId, 'cancelled');
          }
          await notifier.confirmStopped(acceptedMessage);
          return;
        }
        const reason = summarizeErrorMessage(error);
        failed.push({ url: item.url, reason });
        console.error(`Failed to process bulk URL ${item.url}:`, error);
        if (itemId !== undefined) {
          this.db?.failItem(itemId, reason);
        }
        const hasNextLink = index + 1 < items.length;
        await notifier.updateStatus(
          acceptedMessage,
          `Link ${index + 1}/${items.length} gagal: ${reason}${hasNextLink ? '\nLanjut ke link berikutnya...' : ''}`,
        );
      } finally {
        await this.workspaceManager.remove(workspace);
      }
    }

    this.pendingCancellations.delete(acceptedMessage.messageId);
    await notifier.removeDownloadStopButton(acceptedMessage);
    if (failed.length === 0) {
      await notifier.deleteStatus(acceptedMessage);
    } else {
      const header = items.length <= 1
        ? 'Gagal memproses link:'
        : `Bulk selesai: ${completed}/${items.length} berhasil, ${failed.length} gagal.`;
      await notifier.updateStatus(acceptedMessage, buildFailureSummary(header, failed));
    }
  }

  private async processDownloadedVideo(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    outputDir: string,
    initialVideo: Awaited<ReturnType<VideoDownloader['download']>>,
    convertToHeight?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    let video = initialVideo;
    if (convertToHeight !== undefined) {
        await notifier.updateStatus(
          acceptedMessage,
          `Download selesai. Sedang mengonversi video ke resolusi ${convertToHeight}p...`,
        );

        video = await this.videoConverter.convert({
          video,
          outputDir,
          targetHeight: convertToHeight,
          signal,
          onProgress: (percent) => {
            void this.reportConversionProgress(notifier, acceptedMessage, convertToHeight, percent);
          },
        });

        await notifier.updateStatus(
          acceptedMessage,
          'Konversi selesai. Sedang membuat screenshot video...',
        );
      } else if (this.reencodeAnamorphic && (await this.needsAnamorphicBake(video))) {
        // Declared-dimensions trick failed in practice: Telegram clients
        // letterbox by the real frame size, not the declared one. Bake the
        // true display dimensions with a fast re-encode instead.
        await notifier.updateStatus(
          acceptedMessage,
          'Download selesai. Sedang memperbaiki dimensi video...',
        );

        video = await this.videoConverter.convert({
          video,
          outputDir,
          signal,
        });

        await notifier.updateStatus(
          acceptedMessage,
          'Perbaikan dimensi selesai. Sedang membuat screenshot video...',
        );
      } else {
        await notifier.updateStatus(
          acceptedMessage,
          `Download selesai. Sedang membuat ${this.screenshotCount} screenshot video...`,
        );
      }

    const screenshots = await this.tryGenerateScreenshots({
        acceptedMessage,
        notifier,
        outputDir,
        video,
      });

    await notifier.updateStatus(
        acceptedMessage,
        screenshots.length > 0
          ? 'Screenshot selesai. Sedang membuat thumbnail video...'
          : 'Sedang membuat thumbnail video...',
      );

    const thumbnail = await this.tryGenerateThumbnail({
        acceptedMessage,
        notifier,
        outputDir,
        video,
      });

    await notifier.updateStatus(
        acceptedMessage,
        video.fileSize > this.maxFileSizeBytes
          ? `Video lebih dari ${formatBytes(this.maxFileSizeBytes)}, sedang memecah video...`
          : screenshots.length > 0
            ? 'Screenshot selesai. Sedang mengirim video ke Telegram...'
            : 'Sedang mengirim video ke Telegram...',
      );

    const segments = await this.videoSplitter.split(video, outputDir, this.maxFileSizeBytes);

    const shouldCombine =
        this.sendVideoInAlbum &&
        notifier.canCombineScreenshotsWithVideo(screenshots.length) &&
        segments.length === 1;

    await notifier.withMediaSendQueue(async () => {
        if (shouldCombine) {
          const segment = segments[0];
          await notifier.updateStatus(acceptedMessage, 'Screenshot & video siap. Sedang mengirim ke Telegram dalam satu album...');
          await notifier.sendVideoWithScreenshots(screenshots, {
            filePath: segment.filePath,
            fileName: buildDeliveryFileName(segment.filePath, video.title),
            caption: truncateCaption(video.title),
            width: segment.width,
            height: segment.height,
          });
          return;
        }

        if (screenshots.length > 0) {
          await notifier.updateStatus(acceptedMessage, 'Screenshot selesai. Sedang mengirim screenshot ke Telegram...');
          await notifier.sendScreenshots(screenshots);
        }
        for (const segment of segments) {
          await notifier.updateStatus(
            acceptedMessage,
            segments.length > 1
              ? `Sedang mengirim video part ${segment.index}/${segment.total} ke Telegram...`
              : 'Sedang mengirim video ke Telegram...',
          );
          await notifier.sendVideo({
            filePath: segment.filePath,
            fileName: segments.length > 1
              ? buildDeliveryPartFileName(segment.filePath, video.title, segment.index, segment.total)
              : buildDeliveryFileName(segment.filePath, video.title),
            caption: segments.length > 1
              ? buildPartCaption(video.title, segment.index, segment.total)
              : truncateCaption(video.title),
            thumbnail,
            width: segment.width,
            height: segment.height,
          });
        }
    });
  }

  private async tryGenerateScreenshots(options: {
    acceptedMessage: StatusMessage;
    notifier: TelegramNotifier;
    outputDir: string;
    video: Awaited<ReturnType<VideoDownloader['download']>>;
  }) {
    try {
      return await this.videoScreenshotGenerator.generate({
        videoPath: options.video.filePath,
        outputDir: options.outputDir,
        durationSeconds: options.video.durationSeconds,
        count: this.screenshotCount,
      });
    } catch (error) {
      console.error('Failed to generate screenshots:', error);

      await options.notifier.updateStatus(
        options.acceptedMessage,
        'Screenshot gagal dibuat. Video tetap akan dikirim...',
      );

      return [];
    }
  }

  private async tryGenerateThumbnail(options: {
    acceptedMessage: StatusMessage;
    notifier: TelegramNotifier;
    outputDir: string;
    video: Awaited<ReturnType<VideoDownloader['download']>>;
  }): Promise<VideoThumbnail | undefined> {
    try {
      return await this.videoScreenshotGenerator.generateThumbnail({
        videoPath: options.video.filePath,
        outputDir: options.outputDir,
        durationSeconds: options.video.durationSeconds,
      });
    } catch (error) {
      console.error('Failed to generate thumbnail:', error);

      await options.notifier.updateStatus(
        options.acceptedMessage,
        'Thumbnail gagal dibuat. Video tetap akan dikirim...',
      );

      return undefined;
    }
  }

  private async needsAnamorphicBake(video: { filePath: string }): Promise<boolean> {
    try {
      const sar = await this.videoConverter.probeSampleAspectRatio(video.filePath);
      return buildPixelAspectFilter(sar) !== undefined;
    } catch (error) {
      // If probing fails, assume square pixels rather than re-encoding blindly.
      console.error('Failed to probe sample aspect ratio:', error);
      return false;
    }
  }

  private async reportConversionProgress(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    targetHeight: number,
    percent: number,
  ): Promise<void> {
    try {
      await notifier.updateStatus(
        acceptedMessage,
        `Sedang mengonversi ke resolusi ${targetHeight}p... ${percent}%`,
      );
    } catch (error) {
      console.error('Failed to update conversion progress:', error);
    }
  }

  private async reportDownloadProgress(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    progress: VideoDownloadProgress,
  ): Promise<void> {
    if (progress.status !== 'downloading') {
      return;
    }

    try {
      await notifier.updateProgress(acceptedMessage, formatDownloadProgress(progress));
    } catch (error) {
      console.error('Failed to update download progress:', error);
    }
  }
}
