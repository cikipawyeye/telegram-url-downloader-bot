import type { WorkspaceManager } from '../storage/workspace.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, buildDeliveryPartFileName, buildPartCaption, extractUrls, formatBytes, formatDownloadProgress, truncateCaption, type VideoDownloadProgress, type VideoThumbnail } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import { DownloadCancelledError } from './downloader.js';
import type { VideoScreenshotGenerator } from './screenshots.js';
import type { VideoSplitter } from './splitter.js';
import type { VideoConverter } from './converter.js';

export type ProcessVideoMessageRequest = {
  notifier: TelegramNotifier;
  text: string;
  userId: string;
  convertToHeight?: number;
};

export class VideoMessageProcessor {
  private readonly maxFileSizeBytes: number;
  private readonly videoDownloader: VideoDownloader;
  private readonly videoScreenshotGenerator: VideoScreenshotGenerator;
  private readonly videoSplitter: VideoSplitter;
  private readonly videoConverter: VideoConverter;
  private readonly workspaceManager: WorkspaceManager;
  private readonly screenshotCount: number;
  private readonly sendVideoInAlbum: boolean;
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
  }) {
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.videoDownloader = options.videoDownloader;
    this.videoScreenshotGenerator = options.videoScreenshotGenerator;
    this.videoSplitter = options.videoSplitter;
    this.videoConverter = options.videoConverter;
    this.workspaceManager = options.workspaceManager;
    this.screenshotCount = options.screenshotCount;
    this.sendVideoInAlbum = options.sendVideoInAlbum;
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

  async process({ notifier, text, userId, convertToHeight }: ProcessVideoMessageRequest): Promise<void> {
    const urls = extractUrls(text.trim());

    if (urls.length === 0) {
      await notifier.sendInvalidUrl();
      return;
    }

    const maxBulkUrls = parseInt(process.env.MAX_BULK_URLS ?? '20', 10);
    if (urls.length > maxBulkUrls) {
      await notifier.sendBatchLimit(maxBulkUrls);
      return;
    }

    try {
      const acceptedMessage = await notifier.sendAccepted();

      const controller = new AbortController();
      this.pendingCancellations.set(acceptedMessage.messageId, controller);

      await notifier.addDownloadStopButton(
        acceptedMessage,
        `stop:download:${acceptedMessage.messageId}`,
      );

      void this.processBatch(
        notifier,
        acceptedMessage,
        urls,
        userId,
        convertToHeight,
        controller.signal,
      );
    } catch (error) {
      throw error;
    }
  }

  private async processBatch(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    urls: string[],
    userId: string,
    convertToHeight?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const expandedUrls: string[] = [];
    for (const url of urls) {
      try {
        expandedUrls.push(...await this.videoDownloader.expandUrl(url));
      } catch (error) {
        console.error(`Failed to read bulk URL ${url}:`, error);
        await notifier.updateStatus(acceptedMessage, `Gagal membaca album: ${url}`);
      }
    }

    urls = expandedUrls;
    if (urls.length === 0) {
      this.pendingCancellations.delete(acceptedMessage.messageId);
      await notifier.updateStatus(acceptedMessage, 'Tidak ada video yang ditemukan di input tersebut.');
      this.pendingCancellations.delete(acceptedMessage.messageId);
      return;
    }

    const failed: string[] = [];
    let completed = 0;

    for (const [index, url] of urls.entries()) {
      if (signal?.aborted) {
        await notifier.confirmStopped(acceptedMessage);
        this.pendingCancellations.delete(acceptedMessage.messageId);
        return;
      }

      const workspace = await this.workspaceManager.create(userId);
      await notifier.updateStatus(acceptedMessage, `Selesai ${completed}/${urls.length}. Memproses ${index + 1}/${urls.length}...`);

      try {
        const video = await this.videoDownloader.download({
          url,
          outputDir: workspace.dirPath,
          signal,
          onProgress: (progress) => {
            void this.reportDownloadProgress(notifier, acceptedMessage, progress);
          },
        });
        await this.processDownloadedVideo(notifier, acceptedMessage, workspace.dirPath, video, convertToHeight, signal);
        completed += 1;
      } catch (error) {
        if (error instanceof DownloadCancelledError) {
          await notifier.confirmStopped(acceptedMessage);
          return;
        }
        failed.push(url);
        console.error(`Failed to process bulk URL ${url}:`, error);
        await notifier.updateStatus(acceptedMessage, `Link ${index + 1}/${urls.length} gagal. Lanjut ke link berikutnya...`);
      } finally {
        await this.workspaceManager.remove(workspace);
      }
    }

    this.pendingCancellations.delete(acceptedMessage.messageId);
    await notifier.removeDownloadStopButton(acceptedMessage);
    if (failed.length === 0) {
      await notifier.deleteStatus(acceptedMessage);
    } else {
      await notifier.updateStatus(acceptedMessage, `Bulk selesai: ${completed}/${urls.length} berhasil, ${failed.length} gagal.`);
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
