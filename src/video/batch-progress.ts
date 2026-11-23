import type { StatusMessage, TelegramNotifier } from '../telegram/notifier.js';
import type { DownloadErrorKind } from './download-errors.js';
import { formatDownloadProgress, summarizeErrorMessage, type VideoDownloadProgress } from './utils.js';

/**
 * Owns the single status message of a batch while its links download.
 *
 * Prefetch can keep several downloads running at once, but a Telegram message
 * can only show one text. Progress is therefore rendered only for the link the
 * delivery loop is currently waiting on (`watch`), so a link that downloads in
 * the background never overwrites the "sedang mengirim video" status of the
 * link that is actually being delivered.
 */
export class BatchProgressReporter {
  private readonly notifier: TelegramNotifier;
  private readonly statusMessage: StatusMessage;
  private currentIndex = 0;
  private readonly latest = new Map<number, VideoDownloadProgress>();

  constructor(options: { notifier: TelegramNotifier; statusMessage: StatusMessage }) {
    this.notifier = options.notifier;
    this.statusMessage = options.statusMessage;
  }

  /** Make `index` the link that may write progress to the status message. */
  watch(index: number): void {
    this.currentIndex = index;
    const progress = this.latest.get(index);

    if (progress !== undefined) {
      this.render(progress);
    }
  }

  update(index: number, progress: VideoDownloadProgress): void {
    if (progress.status !== 'downloading') {
      this.latest.delete(index);
      return;
    }

    this.latest.set(index, progress);

    if (index === this.currentIndex) {
      this.render(progress);
    }
  }

  markFinished(index: number): void {
    this.latest.delete(index);
  }

  /**
   * Report a failed attempt, but only for the link currently being waited on:
   * retries of prefetched links would otherwise replace the status of another
   * link that is downloading or being sent. Their outcome is reported when the
   * delivery loop reaches them.
   */
  async reportRetry(options: {
    index: number;
    attempt: number;
    maxAttempts: number;
    backoffMs: number;
    error: unknown;
    total: number;
    /** Short classification reason; falls back to the raw error message. */
    reason?: string;
    kind?: DownloadErrorKind;
  }): Promise<void> {
    if (options.index !== this.currentIndex) {
      return;
    }

    this.latest.delete(options.index);

    const header = options.total > 1
      ? `Attempt ${options.attempt}/${options.maxAttempts} gagal (link ${options.index + 1}/${options.total}):`
      : `Attempt ${options.attempt}/${options.maxAttempts} gagal:`;

    const action = options.kind === 'proxy'
      ? `Mencoba lagi dalam ${Math.round(options.backoffMs / 1000)} detik...`
      : `Melanjutkan dari posisi terakhir dalam ${Math.round(options.backoffMs / 1000)} detik...`;

    await this.notifier.updateStatus(
      this.statusMessage,
      `${header} ${options.reason ?? summarizeErrorMessage(options.error)}\n${action}`,
    );
  }

  /**
   * Explain that the download is paused while a refusing local proxy is probed.
   * Only the link the delivery loop is currently waiting on gets status text, so
   * a background retry never clobbers another link's progress.
   */
  async reportProxyWait(options: {
    index: number;
    attempt: number;
    maxAttempts: number;
    waitMs: number;
    elapsedMs?: number;
    total: number;
    reason: string;
  }): Promise<void> {
    if (options.index !== this.currentIndex) {
      return;
    }

    this.latest.delete(options.index);

    const header = options.total > 1
      ? `Attempt ${options.attempt}/${options.maxAttempts} gagal (link ${options.index + 1}/${options.total}):`
      : `Attempt ${options.attempt}/${options.maxAttempts} gagal:`;

    const totalSeconds = Math.max(1, Math.round(options.waitMs / 1000));
    const progress = options.elapsedMs === undefined
      ? `maksimal ${totalSeconds} detik`
      : `${Math.min(totalSeconds, Math.round(options.elapsedMs / 1000))}/${totalSeconds} detik`;

    await this.notifier.updateStatus(
      this.statusMessage,
      `${header} ${options.reason}\nMenunggu proxy lokal siap (${progress})...`,
    );
  }

  private render(progress: VideoDownloadProgress): void {
    void this.notifier
      .updateProgress(this.statusMessage, formatDownloadProgress(progress))
      .catch((error) => {
        console.error('Failed to update download progress:', error);
      });
  }
}
