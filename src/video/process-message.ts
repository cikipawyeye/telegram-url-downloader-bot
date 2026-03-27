import type { DownloadWorkspace, WorkspaceManager } from '../storage/workspace.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, extractFirstUrl, formatBytes, formatDownloadProgress, truncateCaption, type VideoDownloadProgress } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import type { VideoScreenshotGenerator } from './screenshots.js';

export type ProcessVideoMessageRequest = {
  notifier: TelegramNotifier;
  text: string;
  userId: string;
};

export class VideoMessageProcessor {
  private readonly maxFileSizeBytes: number;
  private readonly videoDownloader: VideoDownloader;
  private readonly videoScreenshotGenerator: VideoScreenshotGenerator;
  private readonly workspaceManager: WorkspaceManager;

  constructor(options: {
    maxFileSizeBytes: number;
    videoDownloader: VideoDownloader;
    videoScreenshotGenerator: VideoScreenshotGenerator;
    workspaceManager: WorkspaceManager;
  }) {
    this.maxFileSizeBytes = options.maxFileSizeBytes;
    this.videoDownloader = options.videoDownloader;
    this.videoScreenshotGenerator = options.videoScreenshotGenerator;
    this.workspaceManager = options.workspaceManager;
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

      if (video.fileSize > this.maxFileSizeBytes) {
        await notifier.updateStatus(
          acceptedMessage,
          `Video berhasil didownload, tetapi ukurannya melebihi batas server (${formatBytes(this.maxFileSizeBytes)}).`,
        );

        return;
      }

      await notifier.updateStatus(
        acceptedMessage,
        'Download selesai. Sedang membuat 10 screenshot video...',
      );

      const screenshots = await this.videoScreenshotGenerator.generate({
        videoPath: video.filePath,
        outputDir,
        durationSeconds: video.durationSeconds,
        count: 5,
      });

      await notifier.updateStatus(
        acceptedMessage,
        'Screenshot selesai. Sedang mengirim screenshot ke Telegram...',
      );

      await notifier.sendScreenshots(screenshots);

      await notifier.updateStatus(
        acceptedMessage,
        'Screenshot terkirim. Sedang mengirim video ke Telegram...',
      );

      await notifier.sendVideo({
        filePath: video.filePath,
        fileName: buildDeliveryFileName(video.filePath),
        caption: truncateCaption(video.title),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Terjadi error.';
      await notifier.updateStatus(acceptedMessage, `Gagal memproses link.\n${message}`);
    } finally {
      await this.workspaceManager.remove({ dirPath: outputDir });
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
