import path from 'node:path';
import type { WorkspaceManager } from '../storage/workspace.js';
import type { StatusMessage, TelegramNotifier } from '../telegram/notifier.js';
import type { TelegramMediaDownloader, TelegramVideoSource } from '../telegram/telegram-media.js';
import { DownloadCancelledError } from '../video/downloader.js';
import { buildDeliveryFileName, formatBytes, formatDownloadProgress, summarizeErrorMessage, truncateCaption, type VideoDownloadProgress } from '../video/utils.js';
import type { AudioExtractor } from './extractor.js';

/** Telegram membatasi judul audio 64 karakter. */
const AUDIO_TITLE_MAX_LENGTH = 64;

export type ProcessAudioReplyRequest = {
  notifier: TelegramNotifier;
  media: TelegramVideoSource;
  userId: string;
};

/**
 * Turns a video the bot already sent back into an MP3: the file is fetched from
 * Telegram, its audio track is extracted, and the result is sent as audio.
 */
export class AudioMessageProcessor {
  private readonly mediaDownloader: TelegramMediaDownloader;
  private readonly audioExtractor: AudioExtractor;
  private readonly workspaceManager: WorkspaceManager;
  private readonly maxFileSizeBytes: number;
  private readonly pendingCancellations = new Map<number, AbortController>();

  constructor(options: {
    mediaDownloader: TelegramMediaDownloader;
    audioExtractor: AudioExtractor;
    workspaceManager: WorkspaceManager;
    maxFileSizeBytes: number;
  }) {
    this.mediaDownloader = options.mediaDownloader;
    this.audioExtractor = options.audioExtractor;
    this.workspaceManager = options.workspaceManager;
    this.maxFileSizeBytes = options.maxFileSizeBytes;
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

  async process({ notifier, media, userId }: ProcessAudioReplyRequest): Promise<void> {
    const acceptedMessage = await notifier.sendAccepted('Video diterima. Sedang menyiapkan ekstraksi audio...');
    const controller = new AbortController();
    this.pendingCancellations.set(acceptedMessage.messageId, controller);

    await notifier.addDownloadStopButton(acceptedMessage, `stop:download:${acceptedMessage.messageId}`);

    const workspace = await this.workspaceManager.create(userId);

    try {
      await notifier.updateStatus(acceptedMessage, 'Mengambil video dari Telegram...');

      const downloaded = await this.mediaDownloader.download(media, {
        dirPath: workspace.dirPath,
        signal: controller.signal,
        onProgress: (progress) => {
          void this.reportDownloadProgress(notifier, acceptedMessage, progress);
        },
      });

      const probe = await this.audioExtractor.probe(downloaded.filePath);

      if (!probe.hasAudioStream) {
        throw new Error('Video ini tidak punya track audio untuk diekstrak.');
      }

      await notifier.updateStatus(acceptedMessage, 'Sedang mengekstrak audio dari video...');

      const audio = await this.audioExtractor.extract({
        videoPath: downloaded.filePath,
        outputDir: workspace.dirPath,
        durationSeconds: probe.durationSeconds ?? media.durationSeconds,
        signal: controller.signal,
        onProgress: (percent) => {
          void this.reportExtractionProgress(notifier, acceptedMessage, percent);
        },
      });

      if (audio.fileSize > this.maxFileSizeBytes) {
        throw new Error(
          `Audio hasil ekstraksi ${formatBytes(audio.fileSize)} melebihi batas ${formatBytes(this.maxFileSizeBytes)}.`,
        );
      }

      await notifier.updateStatus(acceptedMessage, 'Sedang mengirim audio ke Telegram...');

      // Reuse the shared media queue so audio keeps the same ordering rules as
      // the videos/screenshots sent for the same chat.
      await notifier.withMediaSendQueue(async () => {
        await notifier.sendAudio({
          filePath: audio.filePath,
          fileName: buildAudioFileName(downloaded.fileName),
          title: buildAudioTitle(downloaded.fileName),
          durationSeconds: audio.durationSeconds ?? media.durationSeconds,
        });
      });

      await notifier.deleteStatus(acceptedMessage);
    } catch (error) {
      if (error instanceof DownloadCancelledError) {
        await notifier.confirmStopped(acceptedMessage);
        return;
      }

      console.error(`Failed to extract audio from Telegram file ${media.fileId}:`, error);
      await notifier.removeDownloadStopButton(acceptedMessage);
      await notifier.updateStatus(acceptedMessage, `Gagal mengekstrak audio: ${summarizeErrorMessage(error)}`);
    } finally {
      this.pendingCancellations.delete(acceptedMessage.messageId);
      await this.workspaceManager.remove(workspace);
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
      console.error('Failed to update Telegram media download progress:', error);
    }
  }

  private async reportExtractionProgress(
    notifier: TelegramNotifier,
    acceptedMessage: StatusMessage,
    percent: number,
  ): Promise<void> {
    try {
      await notifier.updateProgress(acceptedMessage, `Sedang mengekstrak audio dari video... ${percent}%`);
    } catch (error) {
      console.error('Failed to update audio extraction progress:', error);
    }
  }

}

/** `nama video.mp4` -> `nama video.mp3` (nama file audio yang dilihat user). */
export function buildAudioFileName(videoFileName: string): string {
  return buildDeliveryFileName('audio.mp3', buildAudioTitle(videoFileName));
}

/** Judul audio (`title` metadata Telegram), tanpa ekstensi dan sudah dipotong. */
export function buildAudioTitle(videoFileName: string): string {
  const baseName = path.basename(videoFileName, path.extname(videoFileName)).trim();

  return truncateCaption(baseName || 'audio', AUDIO_TITLE_MAX_LENGTH);
}

