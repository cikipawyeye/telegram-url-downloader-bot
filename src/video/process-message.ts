import type { DownloadWorkspace, WorkspaceManager } from '../storage/workspace.js';
import type { BotDatabase } from '../storage/database.js';
import type { DiskSpaceGuard } from '../storage/disk-space.js';
import { InsufficientDiskSpaceError } from '../storage/disk-space.js';
import type { StatusMessage } from '../telegram/notifier.js';
import type { TelegramNotifier } from '../telegram/notifier.js';
import { buildDeliveryFileName, buildDeliveryPartFileName, buildPartCaption, buildFailureSummary, formatBytes, downloadIdentity, hasNoProxyOverride, parseVideoRequestItems, summarizeErrorMessage, truncateCaption, type BatchFailure, type DownloadedVideo, type VideoRequestItem, type VideoThumbnail } from './utils.js';
import type { VideoDownloader } from './downloader.js';
import { DownloadCancelledError } from './downloader.js';
import { BatchProgressReporter } from './batch-progress.js';
import { DownloadSlots } from './download-slots.js';
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

/**
 * One link of a batch: its download starts as soon as the batch is accepted
 * (even while the batch is still waiting for its FIFO delivery turn), and the
 * delivery loop consumes the slot in input order.
 */
type PrefetchSlot = {
  index: number;
  item: VideoRequestItem;
  /**
   * Leftover partial download claimed for this link before the batch starts.
   * Claimed early so a concurrent batch cannot steal it while this one waits.
   */
  resumable?: { itemId: number; resumeDir: string };
  /** Only `pending` slots are cleaned up when a batch ends early. */
  state: 'pending' | 'delivered' | 'failed' | 'cancelled' | 'discarded';
  /** True once the download task finished (succeeded, failed or aborted). */
  settled: boolean;
  workspace?: DownloadWorkspace;
  itemId?: number;
  video?: DownloadedVideo;
  error?: unknown;
  /** Never rejects: the outcome is stored on the slot. */
  task: Promise<void>;
};

type BatchPrefetch = {
  /** Album expansion result; the per-link downloads are already started. */
  ready: Promise<{ items: VideoRequestItem[]; expansionFailures: BatchFailure[] }>;
  reporter: BatchProgressReporter;
  slots: PrefetchSlot[];
  /** True once the per-chat FIFO reached this batch and delivery began. */
  deliveryStarted: boolean;
  /**
   * Remove the workspaces of downloads that finished but will never be
   * delivered (batch stopped or failed). Downloads that are still running are
   * left alone: their partial file is what a resend resumes from.
   */
  discardUndelivered: () => Promise<void>;
  /** Stop a batch that has not started delivering yet (queued Stop button). */
  cancelPending: () => Promise<void>;
};

/** Bookkeeping for the Stop button: one entry per accepted message. */
type PendingBatch = {
  controller: AbortController;
  notifier: TelegramNotifier;
  statusMessage: StatusMessage;
  /** Set right after the accepted status message; used for instant cleanup. */
  prefetch?: BatchPrefetch;
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
  private readonly downloadRetries: number;
  private readonly downloadRetryBackoffMs: number;
  private readonly downloadSlots: DownloadSlots;
  private readonly diskGuard?: DiskSpaceGuard;
  private readonly diskWaitAttempts: number;
  private readonly diskWaitIntervalMs: number;
  private readonly pendingCancellations = new Map<number, PendingBatch>();

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
    /** Automatic download attempts per link; each retry resumes the partial. */
    downloadRetries?: number;
    /** Base delay between attempts, multiplied by the attempt number. */
    downloadRetryBackoffMs?: number;
    /** Process-wide download limiter; share one instance across chats. */
    downloadSlots?: DownloadSlots;
    /** Disk admission control for large downloads; omitted in lightweight tests. */
    diskGuard?: DiskSpaceGuard;
    /** How many times a download waits for free disk before failing (default 4). */
    diskWaitAttempts?: number;
    /** Delay between those disk-space checks (default 15s). */
    diskWaitIntervalMs?: number;
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
    this.downloadRetries = options.downloadRetries ?? 10;
    this.downloadRetryBackoffMs = options.downloadRetryBackoffMs ?? 2000;
    this.downloadSlots = options.downloadSlots ?? new DownloadSlots(1);
    this.diskGuard = options.diskGuard;
    this.diskWaitAttempts = Math.max(1, options.diskWaitAttempts ?? 4);
    this.diskWaitIntervalMs = Math.max(0, options.diskWaitIntervalMs ?? 15_000);
    this.db = options.db;
  }

  cancelDownload(statusMessageId: number): boolean {
    const pending = this.pendingCancellations.get(statusMessageId);

    if (!pending || pending.controller.signal.aborted) {
      return false;
    }

    pending.controller.abort();
    this.pendingCancellations.delete(statusMessageId);

    if (pending.jobId !== undefined) {
      this.db?.cancelItems(pending.jobId);
      this.db?.finishJob(pending.jobId, 'cancelled');
    }

    // A batch that is still waiting for its FIFO turn would otherwise keep
    // "Link diterima..." (and its Stop button) until the previous batch is done,
    // so confirm right away and drop the files it already prefetched.
    if (pending.prefetch !== undefined && !pending.prefetch.deliveryStarted) {
      void pending.prefetch.cancelPending().catch((error) => {
        console.error('Failed to clean up the stopped prefetch:', error);
      });
    }

    void pending.notifier.confirmStopped(pending.statusMessage).catch((error) => {
      console.error('Failed to confirm the stopped download:', error);
    });

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
      // Registered before the Stop button exists, so a very fast tap cannot fall
      // through to "Tidak ada proses yang sedang berjalan".
      const pending: PendingBatch = {
        controller,
        notifier,
        statusMessage: acceptedMessage,
      };
      this.pendingCancellations.set(acceptedMessage.messageId, pending);

      const jobId = this.db?.createJob({
        chatId: notifier.chatId,
        userId: Number(userId) || undefined,
        statusMessageId: acceptedMessage.messageId,
        convertHeight: convertToHeight,
      });
      pending.jobId = jobId;

      await notifier.addDownloadStopButton(
        acceptedMessage,
        `stop:download:${acceptedMessage.messageId}`,
      );

      // Downloads start here, before the batch gets its FIFO delivery turn:
      // the queue below only serializes conversion/screenshots/sending, so a
      // large link is already on disk when the previous link finishes sending.
      const prefetch = this.startPrefetch({
        notifier,
        acceptedMessage,
        items,
        userId,
        batch: { convertToHeight, forceNoProxy, signal: controller.signal, jobId },
      });
      pending.prefetch = prefetch;

      // Catch here: a rejecting batch must never become an unhandled
      // rejection (it crashes the process and kills the stop button).
      this.enqueueBatch(notifier, acceptedMessage, prefetch, {
        convertToHeight,
        forceNoProxy,
        signal: controller.signal,
        jobId,
      }).catch(async (error) => {
        console.error(`Batch failed for status message ${acceptedMessage.messageId}:`, error);

        this.pendingCancellations.delete(acceptedMessage.messageId);
        if (jobId !== undefined) {
          this.db?.cancelItems(jobId);
          this.db?.finishJob(jobId, 'failed');
        }

        await prefetch.discardUndelivered().catch(() => undefined);

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
    prefetch: BatchPrefetch,
    batch: BatchOptions,
  ): Promise<void> {
    const chatId = notifier.chatId;
    const previous = VideoMessageProcessor.batchQueues.get(chatId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.processBatch(notifier, acceptedMessage, prefetch, batch));
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
    prefetch: BatchPrefetch,
    { convertToHeight, signal, jobId }: BatchOptions,
  ): Promise<void> {
    prefetch.deliveryStarted = true;

    const { items, expansionFailures } = await prefetch.ready;

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

    const failed: BatchFailure[] = expansionFailures.slice();
    // Links that failed to expand never became items, so the summary counts the
    // requested links (expanded + failed) to stay consistent with the reasons.
    const totalRequested = items.length + expansionFailures.length;
    let completed = 0;

    for (const [index, slot] of prefetch.slots.entries()) {
      if (signal.aborted) {
        // Keep this link's partial download for a resend, drop the prefetched
        // ones that will never be delivered.
        slot.state = 'cancelled';
        await prefetch.discardUndelivered();
        await notifier.confirmStopped(acceptedMessage);
        this.pendingCancellations.delete(acceptedMessage.messageId);
        return;
      }

      prefetch.reporter.watch(index);

      const noProxyLabel = slot.item.noProxy ? ' tanpa proxy' : '';
      const resumeLabel = slot.resumable !== undefined ? ', melanjutkan download sebelumnya' : '';
      await notifier.updateStatus(
        acceptedMessage,
        `Selesai ${completed}/${items.length}. Memproses ${index + 1}/${items.length}${noProxyLabel}${resumeLabel}...`,
      );

      await slot.task;

      if (slot.error !== undefined) {
        if (slot.error instanceof DownloadCancelledError) {
          slot.state = 'cancelled';
          await prefetch.discardUndelivered();
          if (jobId !== undefined) {
            this.db?.cancelItems(jobId);
            this.db?.finishJob(jobId, 'cancelled');
          }
          await notifier.confirmStopped(acceptedMessage);
          return;
        }

        const reason = summarizeErrorMessage(slot.error);
        failed.push({ url: slot.item.url, reason });
        slot.state = 'failed';
        console.error(`Failed to process bulk URL ${slot.item.url}:`, slot.error);
        if (slot.itemId !== undefined) {
          this.db?.failItem(slot.itemId, reason);
        }
        const hasNextLink = index + 1 < items.length;
        await notifier.updateStatus(
          acceptedMessage,
          `Link ${index + 1}/${items.length} gagal: ${reason}\nKirim ulang link ini untuk melanjutkan dari posisi terakhir.${hasNextLink ? '\nLanjut ke link berikutnya...' : ''}`,
        );
        continue;
      }

      const video = slot.video;
      const workspace = slot.workspace;

      if (video === undefined || workspace === undefined) {
        const reason = 'Unduhan selesai tanpa menghasilkan file video.';
        failed.push({ url: slot.item.url, reason });
        slot.state = 'failed';
        await notifier.updateStatus(acceptedMessage, `Link ${index + 1}/${items.length} gagal: ${reason}`);
        continue;
      }

      try {
        await this.processDownloadedVideo(notifier, acceptedMessage, workspace.dirPath, video, convertToHeight, signal);
        completed += 1;
        slot.state = 'delivered';
        if (slot.itemId !== undefined) {
          this.db?.completeItem(slot.itemId, video);
          this.db?.clearItemResume(slot.itemId);
        }
      } catch (error) {
        if (error instanceof DownloadCancelledError) {
          slot.state = 'cancelled';
          await prefetch.discardUndelivered();
          if (jobId !== undefined) {
            this.db?.cancelItems(jobId);
            this.db?.finishJob(jobId, 'cancelled');
          }
          await notifier.confirmStopped(acceptedMessage);
          return;
        }

        const reason = summarizeErrorMessage(error);
        failed.push({ url: slot.item.url, reason });
        slot.state = 'failed';
        console.error(`Failed to process bulk URL ${slot.item.url}:`, error);
        if (slot.itemId !== undefined) {
          this.db?.failItem(slot.itemId, reason);
        }
        await notifier.updateStatus(
          acceptedMessage,
          `Link ${index + 1}/${items.length} gagal: ${reason}\nKirim ulang link ini untuk melanjutkan dari posisi terakhir.`,
        );
      } finally {
        // On success the workspace is dead weight. On failure/cancel it keeps
        // the downloaded file for a resume attempt; the orphan sweep removes
        // it if the user never comes back.
        if (slot.state === 'delivered') {
          await this.workspaceManager.remove(workspace);
        }
      }
    }

    this.pendingCancellations.delete(acceptedMessage.messageId);
    await notifier.removeDownloadStopButton(acceptedMessage);
    if (failed.length === 0) {
      await notifier.deleteStatus(acceptedMessage);
    } else {
      const header = totalRequested <= 1
        ? 'Gagal memproses link:'
        : `Bulk selesai: ${completed}/${totalRequested} berhasil, ${failed.length} gagal.`;
      await notifier.updateStatus(acceptedMessage, buildFailureSummary(header, failed));
    }
  }

  /**
   * Expand album links and start one download task per resulting video.
   *
   * Called from `process()`, so prefetching is independent from the per-chat
   * FIFO delivery queue: a message that is still waiting for its turn is
   * already downloading. The shared `DownloadSlots` limiter and the
   * `DiskSpaceGuard` bound how many large files can be in flight at once.
   */
  private startPrefetch(options: {
    notifier: TelegramNotifier;
    acceptedMessage: StatusMessage;
    items: VideoRequestItem[];
    userId: string;
    batch: BatchOptions;
  }): BatchPrefetch {
    const { notifier, acceptedMessage, items, userId, batch } = options;
    const reporter = new BatchProgressReporter({ notifier, statusMessage: acceptedMessage });
    const slots: PrefetchSlot[] = [];

    const ready = this.expandItems(items, batch.forceNoProxy).then(({ items: expanded, failures }) => {
      for (const [index, item] of expanded.entries()) {
        // Claim any leftover partial synchronously, before the slot waits for a
        // download slot: the delivery loop needs to know about the resume while
        // it still can put it in the "Memproses ..." status text.
        const resumable = batch.jobId !== undefined
          ? this.db?.takeResumableItem(
              notifier.chatId,
              (url) => downloadIdentity(url) === downloadIdentity(item.url),
            )
          : undefined;

        const slot: PrefetchSlot = {
          index,
          item,
          resumable,
          state: 'pending',
          settled: false,
          task: Promise.resolve(),
        };

        slot.task = this.prefetchItem({
          slot,
          userId,
          total: expanded.length,
          batch,
          reporter,
        });
        slots.push(slot);
      }

      return { items: expanded, expansionFailures: failures };
    });

    const discardUndelivered = async (): Promise<void> => {
      const pending = slots.filter((slot) => slot.state === 'pending');

      for (const slot of pending) {
        slot.state = 'discarded';
      }

      for (const slot of pending) {
        await slot.task;

        // Only finished downloads are removed: a partial download that is
        // still being aborted stays on disk so a resend can resume it.
        if (!slot.settled || slot.workspace === undefined) {
          continue;
        }

        await this.workspaceManager.remove(slot.workspace);

        if (slot.itemId !== undefined) {
          this.db?.clearItemResume(slot.itemId);
        }
      }
    };

    /**
     * Stop a batch that never reached its delivery turn. Nothing was sent, so
     * only a download that is still running keeps its partial (a resend resumes
     * it); files that already finished are deleted to free the disk for the
     * batch that is actually being delivered.
     */
    const cancelPending = async (): Promise<void> => {
      const first = slots[0];

      if (first !== undefined && first.state === 'pending' && !first.settled) {
        first.state = 'cancelled';
      }

      await discardUndelivered();
    };

    return { ready, reporter, slots, deliveryStarted: false, discardUndelivered, cancelPending };
  }

  /** Read the URLs behind the links; album links expand into several videos. */
  private async expandItems(
    items: VideoRequestItem[],
    forceNoProxy: boolean,
  ): Promise<{ items: VideoRequestItem[]; failures: BatchFailure[] }> {
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

    return { items: expandedItems, failures: expansionFailures };
  }

  /**
   * Download one prefetched link: wait for a download slot, reserve disk space,
   * claim a resumable partial, then run the retrying download. The outcome is
   * stored on the slot, so `task` never rejects and the delivery loop can
   * inspect it when the link's turn comes.
   */
  private async prefetchItem(options: {
    slot: PrefetchSlot;
    userId: string;
    total: number;
    batch: BatchOptions;
    reporter: BatchProgressReporter;
  }): Promise<void> {
    const { slot, userId, total, batch, reporter } = options;
    const { signal, jobId } = batch;

    try {
      await this.downloadSlots.acquire(signal);

      try {
        const releaseDisk = await this.reserveDownloadDisk(signal);

        try {
          slot.workspace = await this.workspaceManager.create(userId, { reuseDir: slot.resumable?.resumeDir });

          if (jobId !== undefined) {
            slot.itemId = this.db?.addItem(jobId, slot.item.url, { noProxy: slot.item.noProxy });

            if (slot.itemId !== undefined) {
              this.db?.setItemResumeDir(slot.itemId, slot.workspace.dirPath);
            }
          }

          slot.video = await this.downloadWithRetries({ slot, total, signal, reporter });
        } finally {
          releaseDisk?.();
        }
      } finally {
        // Released even when the download failed, so the next prefetched link
        // (or another chat's link) can start immediately.
        this.downloadSlots.release();
      }
    } catch (error) {
      slot.error = error;

      // The resume claim clears `job_items.resume_dir`; put it back when the
      // link never got a workspace (disk guard, abort while queued) so its
      // partial stays resumable.
      if (slot.workspace === undefined && slot.resumable !== undefined) {
        this.db?.setItemResumeDir(slot.resumable.itemId, slot.resumable.resumeDir);
      }
    } finally {
      slot.settled = true;
      reporter.markFinished(slot.index);
    }
  }

  /**
   * Reserve disk room for one download, waiting briefly when the disk is full
   * of files that are still being sent: those are deleted once delivered, so a
   * 4 GB+ batch on a tight disk recovers instead of failing the next link.
   * Stop aborts the wait through `delay()`.
   */
  private async reserveDownloadDisk(signal: AbortSignal): Promise<(() => void) | undefined> {
    if (this.diskGuard === undefined) {
      return undefined;
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.diskGuard.acquire();
      } catch (error) {
        if (!(error instanceof InsufficientDiskSpaceError) || attempt >= this.diskWaitAttempts) {
          throw error;
        }

        console.warn(
          `Download waiting for free disk (attempt ${attempt}/${this.diskWaitAttempts}): ${error.message}`,
        );
        await this.delay(this.diskWaitIntervalMs, signal);
      }
    }
  }

  private async downloadWithRetries(options: {
    slot: PrefetchSlot;
    total: number;
    signal: AbortSignal;
    reporter: BatchProgressReporter;
  }): Promise<DownloadedVideo> {
    const { slot, total, signal, reporter } = options;
    const workspace = slot.workspace;

    if (workspace === undefined) {
      throw new Error('Workspace unduhan tidak tersedia.');
    }

    const maxAttempts = Math.max(1, this.downloadRetries);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        throw new DownloadCancelledError();
      }

      try {
        return await this.videoDownloader.download({
          url: slot.item.url,
          outputDir: workspace.dirPath,
          signal,
          noProxy: slot.item.noProxy,
          onProgress: (progress) => reporter.update(slot.index, progress),
        });
      } catch (error) {
        if (error instanceof DownloadCancelledError) {
          throw error;
        }

        lastError = error;
        console.error(`Download attempt ${attempt}/${maxAttempts} failed for ${slot.item.url}:`, error);

        if (attempt < maxAttempts) {
          const backoffMs = Math.min(30_000, this.downloadRetryBackoffMs * attempt);
          await reporter.reportRetry({
            index: slot.index,
            attempt,
            maxAttempts,
            backoffMs,
            error,
            total,
          });
          await this.delay(backoffMs, signal);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Abortable sleep used between download retry attempts. */
  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DownloadCancelledError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
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

        // Conversion writes a second full copy next to the download.
        await this.diskGuard?.assertRoomFor(video.fileSize, 'Ruang disk tidak cukup untuk mengonversi video');

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

        // The re-encode writes a second full copy next to the download.
        await this.diskGuard?.assertRoomFor(video.fileSize, 'Ruang disk tidak cukup untuk memperbaiki dimensi video');

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

    // Splitting writes the parts next to the original: on a 4 GB+ video this
    // needs as much free space as the file itself, so fail early with a clear
    // reason instead of letting ffmpeg die with ENOSPC halfway through.
    if (video.fileSize > this.maxFileSizeBytes) {
      await this.diskGuard?.assertRoomFor(video.fileSize, 'Ruang disk tidak cukup untuk memecah video');
    }

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
}
