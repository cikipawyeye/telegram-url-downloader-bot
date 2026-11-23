/**
 * Runnable checks for the T1 retry policy:
 *  - permanent errors fail after one attempt,
 *  - transient errors use all bounded attempts,
 *  - the wall-clock retry budget stops the loop,
 *  - the global download slot is released during backoff,
 *  - Stop interrupts a backoff immediately,
 *  - a refusing local proxy is probed and retried once it accepts connections,
 *  - a proxy that never comes back fails with the noproxy hint.
 *
 * Uses fake downloader/notifier/workspace parts and a real localhost TCP server
 * as the proxy probe target, so no external network is involved.
 *
 * Run with: npx tsx scripts/retry-policy-check.ts
 */
import net from 'node:net';
import path from 'node:path';
import { VideoMessageProcessor } from '../src/video/process-message.js';
import { DownloadSlots } from '../src/video/download-slots.js';
import { classifyDownloadError } from '../src/video/download-errors.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import type { VideoDownloader } from '../src/video/downloader.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { VideoConverter } from '../src/video/converter.js';
import type { WorkspaceManager } from '../src/storage/workspace.js';

const PROXY_ERROR = new Error(
  'yt-dlp exited with code 1: 9of6pn6idi~OUhtDxYA58?token=c8qqt55xgpghi2yc6i323u2c&expiry=1793703945121: ' +
  "Unable to download webpage: ('[Errno 5] Connection refused', Socks5Error(5, 'Connection refused')) " +
  '(caused by ProxyError("[Errno 5] Connection refused", Socks5Error(5, \'Connection refused\')))',
);

type DownloadCall = { url: string; attempt: number; outputDir: string };
type DownloadHandler = (
  options: { url: string; outputDir: string; signal?: AbortSignal },
  attempt: number,
) => Promise<DownloadedVideoLike>;

type DownloadedVideoLike = {
  filePath: string;
  fileSize: number;
  title: string;
  durationSeconds: number;
  width?: number;
  height?: number;
};

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await wait(10);
  }

  throw new Error(`Timed out waiting for ${description}`);
}

function checkIncludes(values: string[], needle: string, description: string): void {
  check(
    values.some((value) => value.includes(needle)),
    `${description}: ${JSON.stringify(values)}`,
  );
}

function videoResult(outputDir: string, title: string): DownloadedVideoLike {
  return {
    filePath: path.join(outputDir, 'video.mp4'),
    fileSize: 1024,
    title,
    durationSeconds: 5,
    width: 640,
    height: 360,
  };
}

function buildDownloader(handler: DownloadHandler) {
  const calls: DownloadCall[] = [];
  const attempts = new Map<string, number>();

  const downloader = {
    async expandUrl(url: string): Promise<string[]> {
      return [url];
    },
    async download(options: { url: string; outputDir: string; signal?: AbortSignal }) {
      const attempt = (attempts.get(options.url) ?? 0) + 1;
      attempts.set(options.url, attempt);
      calls.push({ url: options.url, attempt, outputDir: options.outputDir });
      return await handler(options, attempt);
    },
  } as unknown as VideoDownloader;

  return { downloader, calls };
}

function buildNotifier(chatId: number, messageId: number) {
  const statuses: string[] = [];
  const events: string[] = [];

  const notifier = {
    chatId,
    async sendAccepted(): Promise<StatusMessage> {
      return { messageId };
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {
      events.push('status:deleted');
    },
    async confirmStopped(): Promise<void> {
      events.push('status:stopped');
    },
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
      events.push(`status:${text}`);
    },
    async updateProgress(): Promise<void> {},
    canCombineScreenshotsWithVideo(): boolean {
      return false;
    },
    async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async sendScreenshots(): Promise<void> {},
    async sendVideoWithScreenshots(): Promise<void> {},
    async sendVideo(): Promise<void> {},
  };

  return { notifier: notifier as unknown as TelegramNotifier, statuses, events };
}

function buildWorkspaceManager() {
  let counter = 0;

  return {
    async create(): Promise<{ dirPath: string }> {
      counter += 1;
      return { dirPath: `/tmp/retry-policy-workspace-${counter}` };
    },
    async remove(): Promise<void> {},
  } as unknown as WorkspaceManager;
}

function buildProcessor(options: {
  downloader: VideoDownloader;
  downloadRetries: number;
  downloadRetryBackoffMs: number;
  downloadRetryBudgetMs?: number;
  downloadProxyWaitMs?: number;
  proxy?: string;
  downloadSlots?: DownloadSlots;
}): VideoMessageProcessor {
  return new VideoMessageProcessor({
    maxFileSizeBytes: 2 * 1024 * 1024,
    videoDownloader: options.downloader,
    videoScreenshotGenerator: {
      async generate() {
        return [];
      },
      async generateThumbnail() {
        return undefined;
      },
    } as unknown as VideoScreenshotGenerator,
    videoSplitter: {
      async split(video: { filePath: string; fileSize: number; width?: number; height?: number }) {
        return [{
          filePath: video.filePath,
          fileSize: video.fileSize,
          index: 1,
          total: 1,
          width: video.width,
          height: video.height,
        }];
      },
    } as unknown as VideoSplitter,
    videoConverter: undefined as unknown as VideoConverter,
    workspaceManager: buildWorkspaceManager(),
    screenshotCount: 0,
    sendVideoInAlbum: false,
    reencodeAnamorphic: false,
    downloadRetries: options.downloadRetries,
    downloadRetryBackoffMs: options.downloadRetryBackoffMs,
    downloadRetryBudgetMs: options.downloadRetryBudgetMs,
    downloadProxyWaitMs: options.downloadProxyWaitMs,
    proxy: options.proxy,
    downloadSlots: options.downloadSlots,
  });
}

async function checkClassification(): Promise<void> {
  const proxy = classifyDownloadError(PROXY_ERROR, { proxyActive: true });
  check(proxy.kind === 'proxy', `the reported WARP failure must be classified as proxy: ${proxy.kind}`);
  check(proxy.retryable, 'a proxy connection refusal must stay retryable');

  const privateVideo = classifyDownloadError(new Error('Private video. Sign in if you have been granted access'));
  check(privateVideo.kind === 'permanent', `a private video must be permanent: ${privateVideo.kind}`);
  check(!privateVideo.retryable, 'a private video must not be retried');

  const notFound = classifyDownloadError(new Error('ERROR: [generic] bad: HTTP Error 404: Not Found'));
  check(notFound.kind === 'permanent', `HTTP 404 must be permanent: ${notFound.kind}`);

  const serverBusy = classifyDownloadError(new Error('HTTP Error 503: Service Unavailable'));
  check(serverBusy.kind === 'transient', `HTTP 503 must be transient: ${serverBusy.kind}`);

  const unknown = classifyDownloadError(new Error('boom attempt 1'));
  check(unknown.kind === 'transient', `an unknown error must default to transient: ${unknown.kind}`);

  console.log('[ok] error classification (permanent, transient, proxy)');
}

async function checkPermanentFailsImmediately(): Promise<void> {
  const { downloader, calls } = buildDownloader(async () => {
    throw new Error('Private video. Sign in if you have been granted access');
  });
  const processor = buildProcessor({ downloader, downloadRetries: 5, downloadRetryBackoffMs: 5 });
  const state = buildNotifier(1201, 1401);

  await processor.process({ notifier: state.notifier, text: 'https://example.com/private', userId: '1' });
  await waitFor(
    () => state.statuses.some((text) => text.startsWith('Gagal memproses link:')),
    'the permanent failure summary',
  );

  check(calls.length === 1, `a permanent error must not be retried: ${calls.length} calls`);
  checkIncludes(state.statuses, 'Tidak akan dicoba ulang.', 'the permanent failure must not ask for a resend');
  checkIncludes(
    state.statuses,
    'tidak akan dicoba ulang)',
    'the final summary must mark the permanent failure',
  );
  check(
    !state.statuses.some((text) => text.startsWith('Attempt ')),
    `a permanent error must not report retry attempts: ${JSON.stringify(state.statuses)}`,
  );

  console.log('[ok] permanent errors fail after one attempt');
}

async function checkTransientUsesAllAttempts(): Promise<void> {
  const { downloader, calls } = buildDownloader(async () => {
    throw new Error('read timed out');
  });
  const processor = buildProcessor({ downloader, downloadRetries: 3, downloadRetryBackoffMs: 5 });
  const state = buildNotifier(1202, 1402);

  await processor.process({ notifier: state.notifier, text: 'https://example.com/flaky', userId: '1' });
  await waitFor(
    () => state.statuses.some((text) => text.startsWith('Gagal memproses link:')),
    'the transient failure summary',
  );

  check(calls.length === 3, `a transient error must use all 3 attempts: ${calls.length} calls`);
  checkIncludes(state.statuses, 'Attempt 1/3 gagal: Koneksi timeout.', 'the first retry must be reported');
  checkIncludes(state.statuses, 'Attempt 2/3 gagal: Koneksi timeout.', 'the second retry must be reported');
  checkIncludes(state.statuses, 'Kirim ulang link ini', 'an exhausted transient error must offer a resend');

  console.log('[ok] transient errors use the bounded attempt count');
}

async function checkRetryBudget(): Promise<void> {
  const { downloader, calls } = buildDownloader(async () => {
    // The first attempt alone outlives the whole retry budget.
    await wait(60);
    throw new Error('read timed out');
  });
  const processor = buildProcessor({
    downloader,
    downloadRetries: 5,
    downloadRetryBackoffMs: 1000,
    downloadRetryBudgetMs: 40,
  });
  const state = buildNotifier(1203, 1403);

  await processor.process({ notifier: state.notifier, text: 'https://example.com/slow-failure', userId: '1' });
  await waitFor(
    () => state.statuses.some((text) => text.startsWith('Gagal memproses link:')),
    'the budget failure summary',
  );

  check(calls.length === 1, `the retry budget must stop before the second attempt: ${calls.length} calls`);
  checkIncludes(state.statuses, 'Batas waktu retry', 'the budget failure must name the wall-clock limit');

  console.log('[ok] the wall-clock retry budget stops the loop');
}

async function checkSlotReleasedDuringBackoff(): Promise<void> {
  const firstUrl = 'https://example.com/retrying';
  const secondUrl = 'https://example.com/waiting';
  const { downloader, calls } = buildDownloader(async (options, attempt) => {
    if (options.url === firstUrl && attempt === 1) {
      throw new Error('connection reset by peer');
    }
    return videoResult(options.outputDir, options.url);
  });
  const processor = buildProcessor({
    downloader,
    downloadRetries: 2,
    downloadRetryBackoffMs: 120,
    downloadRetryBudgetMs: 5000,
    downloadSlots: new DownloadSlots(1),
  });
  const state = buildNotifier(1204, 1404);

  await processor.process({ notifier: state.notifier, text: `${firstUrl}\n${secondUrl}`, userId: '1' });
  await waitFor(() => state.events.includes('status:deleted'), 'the batch to finish');

  const firstRetryIndex = calls.findIndex((call) => call.url === firstUrl && call.attempt === 2);
  const secondStartIndex = calls.findIndex((call) => call.url === secondUrl);
  check(firstRetryIndex !== -1 && secondStartIndex !== -1, `both links must download: ${JSON.stringify(calls)}`);
  check(
    secondStartIndex < firstRetryIndex,
    `the waiting link must use the slot before the retry: ${JSON.stringify(calls)}`,
  );

  console.log('[ok] the global slot is released during backoff');
}

async function checkStopDuringBackoff(): Promise<void> {
  const { downloader, calls } = buildDownloader(async () => {
    throw new Error('read timed out');
  });
  const processor = buildProcessor({
    downloader,
    downloadRetries: 5,
    downloadRetryBackoffMs: 5000,
    downloadRetryBudgetMs: 60_000,
  });
  const state = buildNotifier(1205, 1405);

  await processor.process({ notifier: state.notifier, text: 'https://example.com/hanging-retry', userId: '1' });
  await waitFor(
    () => state.statuses.some((text) => text.startsWith('Attempt 1/5 gagal:')),
    'the first retry status',
  );

  const stoppedAt = Date.now();
  check(processor.cancelDownload(1405), 'Stop must be accepted during backoff');
  await waitFor(() => state.events.includes('status:stopped'), 'the stop confirmation', 1000);
  const elapsedMs = Date.now() - stoppedAt;

  check(elapsedMs < 1000, `Stop must not wait for the backoff timer: ${elapsedMs}ms`);
  check(calls.length === 1, `Stop must prevent the next attempt: ${calls.length} calls`);

  console.log('[ok] Stop interrupts a retry backoff immediately');
}

async function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Failed to allocate a proxy test port');
  }

  return { server, port: address.port };
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function checkProxyRecovers(): Promise<void> {
  const { server, port } = await listenOnEphemeralPort();

  try {
    const { downloader, calls } = buildDownloader(async (options, attempt) => {
      if (attempt === 1) {
        throw PROXY_ERROR;
      }
      return videoResult(options.outputDir, options.url);
    });
    const processor = buildProcessor({
      downloader,
      downloadRetries: 3,
      downloadRetryBackoffMs: 5,
      downloadRetryBudgetMs: 10_000,
      downloadProxyWaitMs: 2000,
      proxy: `socks5://127.0.0.1:${port}`,
    });
    const state = buildNotifier(1206, 1406);

    await processor.process({ notifier: state.notifier, text: 'https://example.com/via-proxy', userId: '1' });
    await waitFor(() => state.events.includes('status:deleted'), 'the proxy-recovered batch to finish');

    check(calls.length === 2, `the link must retry after the proxy is ready: ${calls.length} calls`);
    checkIncludes(state.statuses, 'Menunggu proxy lokal siap', 'the status must explain the proxy wait');

    console.log('[ok] a refusing proxy is probed, then the download resumes');
  } finally {
    await closeServer(server);
  }
}

async function checkProxyNeverRecovers(): Promise<void> {
  // Allocate a free port, then close the listener so the probe is refused.
  const { server, port } = await listenOnEphemeralPort();
  await closeServer(server);
  const proxyUrl = `socks5://127.0.0.1:${port}`;

  const { downloader, calls } = buildDownloader(async () => {
    throw PROXY_ERROR;
  });
  const processor = buildProcessor({
    downloader,
    downloadRetries: 3,
    downloadRetryBackoffMs: 5,
    downloadRetryBudgetMs: 10_000,
    downloadProxyWaitMs: 80,
    proxy: proxyUrl,
  });
  const state = buildNotifier(1207, 1407);

  await processor.process({ notifier: state.notifier, text: 'https://example.com/dead-proxy', userId: '1' });
  await waitFor(
    () => state.statuses.some((text) => text.startsWith('Gagal memproses link:')),
    'the dead-proxy failure summary',
  );

  check(calls.length === 1, `a proxy that never returns must not burn attempts: ${calls.length} calls`);
  checkIncludes(state.statuses, 'Proxy lokal masih menolak koneksi', 'the failure must name the proxy');
  checkIncludes(state.statuses, 'noproxy <link>', 'the failure must suggest the noproxy override');

  console.log('[ok] a dead proxy fails with the noproxy hint instead of retrying forever');
}

async function main(): Promise<void> {
  await checkClassification();
  await checkPermanentFailsImmediately();
  await checkTransientUsesAllAttempts();
  await checkRetryBudget();
  await checkSlotReleasedDuringBackoff();
  await checkStopDuringBackoff();
  await checkProxyRecovers();
  await checkProxyNeverRecovers();
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
