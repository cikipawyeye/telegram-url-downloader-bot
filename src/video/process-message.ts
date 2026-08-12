import type { DownloadWorkspace, WorkspaceManager } from '../storage/workspace.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, buildDeliveryPartFileName, buildPartCaption, extractFirstUrl, formatBytes, formatDownloadProgress, truncateCaption, type VideoDownloadProgress, type VideoThumbnail } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import type { VideoScreenshotGenerator } from './screenshots.js';
import type { VideoSplitter } from './splitter.js';

const MIN_FREE_SPACE_BYTES = 1024 * 1024 * 1024; // 1 GiB

export type ProcessVideoMessageRequest = {
  notifier: TelegramNotifier;
  text: string;
  userId: string;
};

export class VideoMessageProcessor {
  private readonly maxFileSizeBytes: number;
  private readonly videoDownloader: VideoDownloader;
  private readonly videoScreenshotGenerator: VideoScreenshotGenerator;
  private readonly videoSplitter: VideoSplitter;
  private readonly workspaceManager: WorkspaceManager;
  private readonly screenshotCount: number;
  private readonly sendVideoInAlbum: boolean;

  constructor(options: {
    maxFileSizeBytes: number;
    videoDownloader: VideoDownloader;
    videoScreenshotGenerator: VideoScreenshotGenerator;
    videoSplitter: VideoSplitter;
    workspaceManager: WorkspaceManager;
    screenshotCount: number;
    sendVideoInAlbum: boolean;
  }) {
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.videoDownloader = options.videoDownloader;
    this.videoScreenshotGenerator = options.videoScreenshotGenerator;
    this.videoSplitter = options.videoSplitter;
    this.workspaceManager = options.workspaceManager;
    this.screenshotCount = options.screenshotCount;
    this.sendVideoInAlbum = options.sendVideoInAlbum;
  }

  async process({ notifier, text, userId }: ProcessVideoMessageRequest): Promise<void> {
    const url = extractFirstUrl(text.trim());

    if (!url) {
      await notifier.sendInvalidUrl();
      return;
    }

    const freeSpaceBytes = await this.workspaceManager.getFreeSpaceBytes();

    if (freeSpaceBytes < MIN_FREE_SPACE_BYTES) {
      await notifier.sendStorageLow();
      return;
    }

    let workspace: DownloadWorkspace | null = null;

    try {
      workspace = await this.workspaceManager.create(userId);
      const acceptedMessage = await notifier.sendAccepted();

      void this.processDownload(notifier, acceptedMessage, workspace.dirPath, url);
    } catch (error) {
      if (workspace) {
        await this.workspaceManager.remove(workspace);
      }

      throw error;
    }
  }

  private async processDownload(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    outputDir: string,
    url: string,
  ): Promise<void> {
    try {
      const video = await this.videoDownloader.download({
        url,
        outputDir,
        onProgress: (progress) => {
          void this.reportDownloadProgress(notifier, acceptedMessage, progress);
        },
      });

      await notifier.updateStatus(
        acceptedMessage,
        `Download selesai. Sedang membuat ${this.screenshotCount} screenshot video...`,
      );

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

      if (shouldCombine) {
        const segment = segments[0];

        await notifier.updateStatus(
          acceptedMessage,
          'Screenshot & video siap. Sedang mengirim ke Telegram dalam satu album...',
        );

        await notifier.sendVideoWithScreenshots(screenshots, {
          filePath: segment.filePath,
          fileName: buildDeliveryFileName(segment.filePath, video.title),
          caption: truncateCaption(video.title),
          width: video.width,
          height: video.height,
        });
      } else {
        if (screenshots.length > 0) {
          await notifier.updateStatus(
            acceptedMessage,
            'Screenshot selesai. Sedang mengirim screenshot ke Telegram...',
          );

          await notifier.sendScreenshots(screenshots);
        }

        if (segments.length > 1) {
          await notifier.updateStatus(
            acceptedMessage,
            `Video berhasil dipecah menjadi ${segments.length} part. Sedang mengirim ke Telegram...`,
          );
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
            width: video.width,
            height: video.height,
          });
        }
      }

      try {
        await notifier.deleteStatus(acceptedMessage);
      } catch (error) {
        console.error('Failed to delete status message:', error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Terjadi error.';
      await notifier.updateStatus(acceptedMessage, `Gagal memproses link.\n${message}`);
    } finally {
      await this.workspaceManager.remove({ dirPath: outputDir });
    }
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
