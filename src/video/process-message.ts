import type { DownloadWorkspace, WorkspaceManager } from '../storage/workspace.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, buildDeliveryPartFileName, buildPartCaption, extractFirstUrl, formatBytes, formatDownloadProgress, truncateCaption, type VideoDownloadProgress } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import type { VideoScreenshotGenerator } from './screenshots.js';
import type { VideoSplitter } from './splitter.js';

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

  constructor(options: {
    maxFileSizeBytes: number;
    videoDownloader: VideoDownloader;
    videoScreenshotGenerator: VideoScreenshotGenerator;
    videoSplitter: VideoSplitter;
    workspaceManager: WorkspaceManager;
    screenshotCount: number;
  }) {
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.videoDownloader = options.videoDownloader;
    this.videoScreenshotGenerator = options.videoScreenshotGenerator;
    this.videoSplitter = options.videoSplitter;
    this.workspaceManager = options.workspaceManager;
    this.screenshotCount = options.screenshotCount;
  }

  async process({ notifier, text, userId }: ProcessVideoMessageRequest): Promise<void> {
    const url = extractFirstUrl(text.trim());

    if (!url) {
      await notifier.sendInvalidUrl();
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

      if (screenshots.length > 0) {
        await notifier.updateStatus(
          acceptedMessage,
          'Screenshot selesai. Sedang mengirim screenshot ke Telegram...',
        );

        await notifier.sendScreenshots(screenshots);
      }

      await notifier.updateStatus(
        acceptedMessage,
        screenshots.length > 0 && video.fileSize > this.maxFileSizeBytes
          ? `Screenshot terkirim. Video lebih dari ${formatBytes(this.maxFileSizeBytes)}, sedang memecah video...`
          : video.fileSize > this.maxFileSizeBytes
            ? `Video lebih dari ${formatBytes(this.maxFileSizeBytes)}, sedang memecah video...`
            : screenshots.length > 0
              ? 'Screenshot terkirim. Sedang mengirim video ke Telegram...'
              : 'Sedang mengirim video ke Telegram...',
      );

      const segments = await this.videoSplitter.split(video, outputDir, this.maxFileSizeBytes);

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
        });
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
