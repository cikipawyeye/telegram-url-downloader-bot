/**
 * Runnable end-to-end check that a failed download reports the real error to
 * the user through the Telegram status message. Uses a fake notifier/downloader
 * so no network, yt-dlp or ffmpeg is involved.
 *
 * Run with: npx tsx scripts/batch-failure-check.ts
 */
import { VideoMessageProcessor } from '../src/video/process-message.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import type { VideoDownloader } from '../src/video/downloader.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { VideoConverter } from '../src/video/converter.js';
import type { WorkspaceManager } from '../src/storage/workspace.js';

const FAILING_URL = 'https://example.com/bad-video';
const OK_URL = 'https://example.com/good-video';
const FAILURE_REASON = 'yt-dlp exited with code 1: ERROR: [youtube] bad: Video unavailable';

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function buildNotifier(chatId: number) {
  const statuses: string[] = [];
  const notifier = {
    chatId,
    async sendAccepted(): Promise<StatusMessage> {
      return { messageId: 777 };
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {},
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
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

  return { notifier: notifier as unknown as TelegramNotifier, statuses };
}

function buildDownloader(): VideoDownloader {
  return {
    async expandUrl(url: string): Promise<string[]> {
      return [url];
    },
    async download(options: { url: string }) {
      if (options.url === FAILING_URL) {
        throw new Error(FAILURE_REASON);
      }

      return {
        filePath: '/tmp/fake-video.mp4',
        fileSize: 1024,
        title: 'Video OK',
        durationSeconds: 5,
        width: 640,
        height: 360,
      };
    },
  } as unknown as VideoDownloader;
}

function buildProcessor(): VideoMessageProcessor {
  return new VideoMessageProcessor({
    maxFileSizeBytes: 2 * 1024 * 1024,
    videoDownloader: buildDownloader(),
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
    workspaceManager: {
      async create() {
        return { dirPath: '/tmp/fake-workspace' };
      },
      async remove() {},
    } as unknown as WorkspaceManager,
    screenshotCount: 0,
    sendVideoInAlbum: false,
    reencodeAnamorphic: false,
  });
}

async function waitForStatus(statuses: string[], pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = statuses.find((text) => pattern.test(text));

    if (match !== undefined) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for a status matching ${pattern}. Seen: ${JSON.stringify(statuses)}`);
}

async function main(): Promise<void> {
  const processor = buildProcessor();

  // 1) Single failing link: the reason must replace the bare counter message.
  const single = buildNotifier(901);
  await processor.process({ notifier: single.notifier, text: FAILING_URL, userId: '1' });
  const singleFailure = await waitForStatus(single.statuses, /^Gagal memproses link:/);

  check(singleFailure.includes(FAILING_URL), `single failure should name the link: ${singleFailure}`);
  check(singleFailure.includes('Video unavailable'), `single failure should include the reason: ${singleFailure}`);
  check(
    !single.statuses.includes('Bulk selesai: 0/1 berhasil, 1 gagal.'),
    'the bare counters message should no longer be used on its own',
  );
  check(
    single.statuses.some((text) => text.startsWith('Link 1/1 gagal: ')),
    `the in-progress failure status should also carry the reason: ${JSON.stringify(single.statuses)}`,
  );

  // 2) Mixed batch: one failure with its reason, the successful link is not blamed.
  const bulk = buildNotifier(902);
  await processor.process({ notifier: bulk.notifier, text: `${FAILING_URL}\n${OK_URL}`, userId: '1' });
  const bulkFailure = await waitForStatus(bulk.statuses, /^Bulk selesai: /);

  check(
    bulkFailure.startsWith('Bulk selesai: 1/2 berhasil, 1 gagal.'),
    `bulk header should keep the counters: ${bulkFailure}`,
  );
  check(bulkFailure.includes(FAILING_URL), `bulk summary should name the failed link: ${bulkFailure}`);
  check(bulkFailure.includes('Video unavailable'), `bulk summary should include the reason: ${bulkFailure}`);
  check(!bulkFailure.includes(OK_URL), `bulk summary should not blame successful links: ${bulkFailure}`);

  console.log('single failure status:', JSON.stringify(singleFailure));
  console.log('bulk failure status:', JSON.stringify(bulkFailure));
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
