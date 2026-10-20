/**
 * Runnable checks for the download prefetch pipeline:
 *  - the next link downloads while the current link is still being sent,
 *  - a message that is still waiting in the FIFO queue already downloads,
 *  - delivery order stays the same as the input order,
 *  - a full disk fails the link with a clear reason instead of downloading,
 *  - Stop removes prefetched-but-undelivered files and keeps the active one.
 *
 * Uses fake downloader/notifier/splitter, so no network, yt-dlp or ffmpeg is
 * involved.
 *
 * Run with: npx tsx scripts/prefetch-check.ts
 */
import { VideoMessageProcessor } from '../src/video/process-message.js';
import { DownloadSlots } from '../src/video/download-slots.js';
import { DiskSpaceGuard } from '../src/storage/disk-space.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import { DownloadCancelledError } from '../src/video/downloader.js';
import type { VideoDownloader } from '../src/video/downloader.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { VideoConverter } from '../src/video/converter.js';
import type { WorkspaceManager } from '../src/storage/workspace.js';

const CHAT_ID = 555;
const CANCEL_CHAT_ID = 999;
const GIB = 1024 ** 3;

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

function eventIndex(events: string[], event: string): number {
  const index = events.indexOf(event);

  if (index === -1) {
    throw new Error(`Missing event ${event}. Seen: ${JSON.stringify(events)}`);
  }

  return index;
}

type Recorder = (event: string) => void;

function buildNotifier(options: {
  chatId: number;
  messageId: number;
  record: Recorder;
  sendMs: number;
}): TelegramNotifier {
  const { chatId, messageId, record, sendMs } = options;

  return {
    chatId,
    async sendAccepted(): Promise<StatusMessage> {
      return { messageId };
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {
      record('status:deleted');
    },
    async confirmStopped(): Promise<void> {
      record('status:stopped');
    },
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      record(`status:${text}`);
    },
    async updateProgress(_statusMessage: StatusMessage, text: string): Promise<void> {
      record(`progress:${text.split('\n')[0]}`);
    },
    canCombineScreenshotsWithVideo(): boolean {
      return false;
    },
    async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async sendScreenshots(): Promise<void> {},
    async sendVideoWithScreenshots(): Promise<void> {},
    async sendVideo(video: { fileName: string }): Promise<void> {
      record(`send-start:${video.fileName}`);

      if (sendMs > 0) {
        await wait(sendMs);
      }

      record(`send-end:${video.fileName}`);
    },
  } as unknown as TelegramNotifier;
}


function buildDownloader(options: {
  record: Recorder;
  durations: Record<string, number>;
  signalAware?: boolean;
}): VideoDownloader {
  const { record, durations, signalAware } = options;

  return {
    async expandUrl(url: string): Promise<string[]> {
      return [url];
    },
    async download(downloadOptions: {
      url: string;
      signal?: AbortSignal;
      onProgress?: (progress: { status: 'downloading'; percent: number }) => void;
    }) {
      const url = downloadOptions.url;
      record(`download:start:${url}`);
      downloadOptions.onProgress?.({ status: 'downloading', percent: 42 });

      const durationMs = durations[url] ?? 5;

      if (signalAware === true) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DownloadCancelledError());
          };
          const timer = setTimeout(() => {
            downloadOptions.signal?.removeEventListener('abort', onAbort);
            resolve();
          }, durationMs);

          if (downloadOptions.signal?.aborted) {
            onAbort();
            return;
          }

          downloadOptions.signal?.addEventListener('abort', onAbort, { once: true });
        });
      } else {
        await wait(durationMs);
      }

      record(`download:end:${url}`);

      const title = url.split('/').pop() ?? 'video';

      return {
        filePath: `/tmp/fake/${title}.mp4`,
        fileSize: 1024,
        title,
        durationSeconds: 5,
        width: 640,
        height: 360,
      };
    },
  } as unknown as VideoDownloader;
}

function buildWorkspaceManager(record: Recorder): WorkspaceManager {
  let counter = 0;

  return {
    async create(): Promise<{ dirPath: string }> {
      counter += 1;
      const dirPath = `/tmp/fake-workspace-${counter}`;
      record(`workspace:create:${dirPath}`);

      return { dirPath };
    },
    async remove(workspace: { dirPath: string }): Promise<void> {
      record(`workspace:remove:${workspace.dirPath}`);
    },
  } as unknown as WorkspaceManager;
}

function buildProcessor(options: {
  downloader: VideoDownloader;
  record: Recorder;
  workspaceManager?: WorkspaceManager;
  downloadSlots?: DownloadSlots;
  diskGuard?: DiskSpaceGuard;
  diskWaitAttempts?: number;
  diskWaitIntervalMs?: number;
}): VideoMessageProcessor {
  return new VideoMessageProcessor({
    maxFileSizeBytes: 4 * 1024 * 1024,
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
    workspaceManager: options.workspaceManager ?? buildWorkspaceManager(options.record),
    screenshotCount: 0,
    sendVideoInAlbum: false,
    reencodeAnamorphic: false,
    downloadRetries: 2,
    downloadRetryBackoffMs: 5,
    downloadSlots: options.downloadSlots,
    diskGuard: options.diskGuard,
    diskWaitAttempts: options.diskWaitAttempts,
    diskWaitIntervalMs: options.diskWaitIntervalMs,
  });
}

async function checkIntraBatchPrefetch(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  const sendMs = 60;
  const downloader = buildDownloader({
    record,
    durations: {
      'https://example.com/link-1': 30,
      'https://example.com/link-2': 10,
    },
  });
  const processor = buildProcessor({
    downloader,
    record,
    downloadSlots: new DownloadSlots(1),
  });
  const notifier = buildNotifier({ chatId: CHAT_ID, messageId: 801, record, sendMs });

  await processor.process({
    notifier,
    text: 'https://example.com/link-1\nhttps://example.com/link-2',
    userId: '1',
  });

  await waitFor(() => events.includes('status:deleted'), 'batch completion');

  check(
    eventIndex(events, 'download:start:https://example.com/link-2') <
      eventIndex(events, 'send-end:link-1.mp4'),
    `link 2 should download before link 1 finishes sending: ${JSON.stringify(events)}`,
  );
  check(
    eventIndex(events, 'send-end:link-1.mp4') < eventIndex(events, 'send-end:link-2.mp4'),
    `delivery must keep the input order: ${JSON.stringify(events)}`,
  );
  check(
    eventIndex(events, 'send-start:link-1.mp4') < eventIndex(events, 'send-start:link-2.mp4'),
    `link 1 must be sent first: ${JSON.stringify(events)}`,
  );

  console.log('[ok] intra-batch prefetch + delivery order');
}

async function checkQueuedBatchPrefetch(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  const sendMs = 80;
  const downloader = buildDownloader({
    record,
    durations: {
      'https://example.com/first': 20,
      'https://example.com/second': 5,
      'https://example.com/queued': 5,
    },
  });
  const processor = buildProcessor({
    downloader,
    record,
    downloadSlots: new DownloadSlots(1),
  });
  const first = buildNotifier({ chatId: CHAT_ID + 1, messageId: 811, record, sendMs });
  const queued = buildNotifier({ chatId: CHAT_ID + 1, messageId: 812, record, sendMs });

  await processor.process({
    notifier: first,
    text: 'https://example.com/first\nhttps://example.com/second',
    userId: '1',
  });
  await wait(5);
  await processor.process({
    notifier: queued,
    text: 'https://example.com/queued',
    userId: '1',
  });

  await waitFor(
    () => events.filter((event) => event === 'status:deleted').length === 2,
    'both batches to finish',
  );

  check(
    eventIndex(events, 'download:start:https://example.com/queued') <
      eventIndex(events, 'send-end:first.mp4'),
    `a queued message should download while the previous one is still sending: ${JSON.stringify(events)}`,
  );
  check(
    eventIndex(events, 'download:start:https://example.com/queued') <
      eventIndex(events, 'send-start:queued.mp4'),
    `the queued message must not download only after its turn: ${JSON.stringify(events)}`,
  );

  console.log('[ok] queued batch prefetch (FIFO only serializes delivery)');
}


async function checkDiskGuard(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  let downloadCalled = false;
  const downloader = {
    async expandUrl(url: string): Promise<string[]> {
      return [url];
    },
    async download() {
      downloadCalled = true;
      throw new Error('download must not start when the disk is full');
    },
  } as unknown as VideoDownloader;
  const diskGuard = new DiskSpaceGuard({
    dir: '/tmp/fake-download-dir',
    minFreeBytes: 6 * GIB,
    reserveBytes: 4 * GIB,
    readFreeBytes: async () => 1 * GIB,
  });
  const processor = buildProcessor({
    downloader,
    record,
    diskGuard,
    // Fail immediately instead of waiting: the retry path is covered below.
    diskWaitAttempts: 1,
  });
  const notifier = buildNotifier({ chatId: CHAT_ID + 2, messageId: 821, record, sendMs: 0 });

  await processor.process({ notifier, text: 'https://example.com/huge', userId: '1' });
  await waitFor(
    () => events.some((event) => event.startsWith('status:Gagal memproses link:')),
    'disk-guard batch completion',
  );

  check(!downloadCalled, 'the download must be refused before it starts');
  check(
    events.some((event) => event.includes('Ruang disk tidak cukup')),
    `the status must explain the disk problem: ${JSON.stringify(events)}`,
  );

  console.log('[ok] disk guard refuses a 4 GB+ download without space');
}

async function checkDiskRecoversWhenSpaceFrees(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  let probes = 0;
  const diskGuard = new DiskSpaceGuard({
    dir: '/tmp/fake-download-dir',
    minFreeBytes: 6 * GIB,
    reserveBytes: 4 * GIB,
    // First probe is too low, then the earlier delivery frees the disk.
    readFreeBytes: async () => (probes++ === 0 ? 1 * GIB : 20 * GIB),
  });
  const downloader = buildDownloader({
    record,
    durations: { 'https://example.com/after-freeing': 5 },
  });
  const processor = buildProcessor({
    downloader,
    record,
    diskGuard,
    diskWaitAttempts: 3,
    diskWaitIntervalMs: 5,
  });
  const notifier = buildNotifier({ chatId: CHAT_ID + 3, messageId: 841, record, sendMs: 0 });

  await processor.process({ notifier, text: 'https://example.com/after-freeing', userId: '1' });
  await waitFor(() => events.includes('status:deleted'), 'recovered batch completion');

  check(
    events.includes('download:start:https://example.com/after-freeing'),
    `the download must start once space frees up: ${JSON.stringify(events)}`,
  );

  console.log('[ok] a temporarily full disk waits for space instead of failing');
}

async function checkQueuedStopConfirmsImmediately(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  const sendMs = 120;
  const downloader = buildDownloader({
    record,
    durations: {
      'https://example.com/a1': 20,
      'https://example.com/a2': 20,
      'https://example.com/queued-stop': 5,
    },
  });
  const processor = buildProcessor({
    downloader,
    record,
    downloadSlots: new DownloadSlots(1),
  });
  const chatId = CHAT_ID + 4;
  const first = buildNotifier({ chatId, messageId: 851, record, sendMs });
  const queued = buildNotifier({ chatId, messageId: 852, record, sendMs });

  await processor.process({
    notifier: first,
    text: 'https://example.com/a1\nhttps://example.com/a2',
    userId: '1',
  });
  await wait(5);
  await processor.process({
    notifier: queued,
    text: 'https://example.com/queued-stop',
    userId: '1',
  });

  // The queued batch prefetched its link but is still waiting for its FIFO turn.
  await waitFor(
    () => events.includes('download:end:https://example.com/queued-stop'),
    'the queued batch to finish prefetching',
  );
  check(!events.includes('send-start:queued-stop.mp4'), 'the queued batch must not deliver yet');

  check(processor.cancelDownload(852), 'the queued batch must accept the stop');

  await waitFor(() => events.includes('status:stopped'), 'immediate stop confirmation', 1000);

  check(
    events.includes('send-start:a1.mp4') && !events.includes('send-end:a1.mp4'),
    `Stop must be confirmed while the previous batch is still sending: ${JSON.stringify(events)}`,
  );

  // The prefetched 4 GB+ file is dropped immediately to free the disk.
  await waitFor(
    () => events.includes('workspace:remove:/tmp/fake-workspace-3'),
    'immediate cleanup of the stopped prefetch',
    1000,
  );

  // With the confirmation the inline keyboard is dropped, so a second tap has
  // nothing left to cancel.
  check(!processor.cancelDownload(852), 'a second stop must report nothing running');

  console.log('[ok] stopping a queued batch confirms immediately and frees its files');
}

async function checkCancelCleanup(): Promise<void> {
  const events: string[] = [];
  const record: Recorder = (event) => events.push(event);
  const downloader = buildDownloader({
    record,
    signalAware: true,
    durations: {
      'https://example.com/hang': 10_000,
      'https://example.com/done': 5,
    },
  });
  const processor = buildProcessor({
    downloader,
    record,
    downloadSlots: new DownloadSlots(3),
  });
  const notifier = buildNotifier({ chatId: CANCEL_CHAT_ID, messageId: 831, record, sendMs: 40 });

  await processor.process({
    notifier,
    text: 'https://example.com/hang\nhttps://example.com/done',
    userId: '1',
  });

  await waitFor(
    () =>
      events.includes('download:start:https://example.com/hang') &&
      events.includes('download:end:https://example.com/done'),
    'both downloads to start/finish',
  );

  const cancelled = processor.cancelDownload(831);
  check(cancelled, 'cancelDownload should accept the running batch');

  await waitFor(() => events.includes('status:stopped'), 'stop confirmation');

  // The finished-but-undelivered download is removed, the interrupted one is
  // kept as a partial for the resend/resume flow.
  await waitFor(
    () => events.includes('workspace:remove:/tmp/fake-workspace-2'),
    'cleanup of the prefetched, undelivered file',
    2000,
  );

  check(
    events.includes('workspace:remove:/tmp/fake-workspace-2'),
    `the prefetched, undelivered workspace must be removed: ${JSON.stringify(events)}`,
  );
  check(
    !events.includes('workspace:remove:/tmp/fake-workspace-1'),
    `the interrupted workspace must stay for resume: ${JSON.stringify(events)}`,
  );
  check(
    !events.some((event) => event.startsWith('send-start:')),
    `nothing should be sent after Stop: ${JSON.stringify(events)}`,
  );

  console.log('[ok] Stop keeps the active partial and drops prefetched files');
}

async function main(): Promise<void> {
  await checkIntraBatchPrefetch();
  await checkQueuedBatchPrefetch();
  await checkDiskGuard();
  await checkDiskRecoversWhenSpaceFrees();
  await checkQueuedStopConfirmsImmediately();
  await checkCancelCleanup();
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

