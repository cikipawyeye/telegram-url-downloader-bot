import { DownloadCancelledError } from './downloader.js';

type Waiter = {
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: () => void;
};

/**
 * Process-wide limiter for concurrent downloads.
 *
 * Batches start prefetching while they are still queued for delivery, so
 * without a limiter a burst of links would open one `yt-dlp`/`gdown` process
 * per link. The limit keeps that predictable (default 1 is already enough to
 * overlap "download link 2" with "send link 1"). Waiters are FIFO and
 * abortable, so the Stop button stays responsive while links are queued.
 */
export class DownloadSlots {
  private readonly limit: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);

    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** Take one slot; resolves once this caller owns it. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);

          if (index !== -1) {
            this.waiters.splice(index, 1);
          }

          reject(new DownloadCancelledError());
        },
        resolve: () => resolve(),
      };

      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);

      // The signal may have aborted between the check above and this listener
      // registration; AbortSignal never replays the event, so re-check it.
      if (signal?.aborted) {
        waiter.onAbort();
      }
    });
  }

  /** Give a slot back, or hand it straight to the next waiter. */
  release(): void {
    const next = this.waiters.shift();

    if (next !== undefined) {
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }

    this.active = Math.max(0, this.active - 1);
  }
}
