import type { DownloadWorkspace, DownloadWorkspaceStore } from '../ports/download-workspace-store.js';
import type { VideoDownloader } from '../ports/video-downloader.js';
import type { StatusMessage, VideoRequestNotifier } from '../ports/video-request-notifier.js';
import type { VideoScreenshotGenerator } from '../ports/video-screenshot-generator.js';
import { buildDeliveryFileName, extractFirstUrl, formatBytes, formatDownloadProgress, truncateCaption, type VideoDownloadProgress } from '../../domain/video.js';

type ProcessVideoMessageUseCaseDependencies = {
  maxFileSizeBytes: number;
  videoDownloader: VideoDownloader;
  videoScreenshotGenerator: VideoScreenshotGenerator;
  workspaceStore: DownloadWorkspaceStore;
};

export type ProcessVideoMessageRequest = {
  notifier: VideoRequestNotifier;
  text: string;
  userId: string;
};

export class ProcessVideoMessageUseCase {
  private readonly maxFileSizeBytes: number;
  private readonly videoDownloader: VideoDownloader;
  private readonly videoScreenshotGenerator: VideoScreenshotGenerator;
  private readonly workspaceStore: DownloadWorkspaceStore;

  constructor(dependencies: ProcessVideoMessageUseCaseDependencies) {
    this.maxFileSizeBytes = dependencies.maxFileSizeBytes;
    this.videoDownloader = dependencies.videoDownloader;
    this.videoScreenshotGenerator = dependencies.videoScreenshotGenerator;
    this.workspaceStore = dependencies.workspaceStore;
  }

  async execute(request: ProcessVideoMessageRequest): Promise<void> {
    const url = extractFirstUrl(request.text.trim());

    if (!url) {
      await request.notifier.sendInvalidUrl();
      return;
    }

    let workspace: DownloadWorkspace | null = null;

    try {
      workspace = await this.workspaceStore.create(request.userId);
      const acceptedMessage = await request.notifier.sendAccepted();

      void this.processAcceptedRequest(request.notifier, acceptedMessage, workspace.dirPath, url);
    } catch (error) {
      if (workspace) {
        await this.workspaceStore.remove(workspace);
      }

      throw error;
    }
  }

  private async processAcceptedRequest(
    notifier: VideoRequestNotifier,
    acceptedMessage: StatusMessage,
    outputDir: string,
    url: string,
  ): Promise<void> {
    try {
      const result = await this.videoDownloader.download({
        url,
        outputDir,
        onProgress: (progress) => {
          void this.reportDownloadProgress(notifier, acceptedMessage, progress);
        },
      });

      if (result.fileSize > this.maxFileSizeBytes) {
        await notifier.updateStatus(
          acceptedMessage,
          `Video berhasil didownload, tetapi ukurannya melebihi batas server (${formatBytes(this.maxFileSizeBytes)}).`,
        );

        return;
      }

      await notifier.updateStatus(
        acceptedMessage,
        'Download selesai. Sedang membuat 5 screenshot video...',
      );

      const screenshots = await this.videoScreenshotGenerator.generate({
        videoPath: result.filePath,
        outputDir,
        durationSeconds: result.durationSeconds,
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
        filePath: result.filePath,
        fileName: buildDeliveryFileName(result.filePath),
        caption: truncateCaption(result.title),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Terjadi error.';

      await notifier.updateStatus(acceptedMessage, `Gagal memproses link.\n${message}`);
    } finally {
      await this.workspaceStore.remove({ dirPath: outputDir });
    }
  }

  private async reportDownloadProgress(
    notifier: VideoRequestNotifier,
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
