/**
 * Runnable end-to-end check for the download retry loop and cross-message
 * resume: a flaky downloader must reuse the same workspace across retries, a
 * failed item must keep its workspace (recorded as resume_dir), and resending
 * the same file under a different URL must claim and finish that workspace.
 * Uses a real SQLite DB + WorkspaceManager with fake Telegram/downloader parts.
 *
 * Run with: npx tsx scripts/retry-resume-check.ts
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BotDatabase } from '../src/storage/database.js';
import { WorkspaceManager } from '../src/storage/workspace.js';
import { VideoMessageProcessor } from '../src/video/process-message.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import type { VideoDownloader } from '../src/video/downloader.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { VideoConverter } from '../src/video/converter.js';

const TMP_DIR = '/tmp/retry-resume-check';

// Same file identity (bunkr fileId), different URLs (the "expired URL" case).
const URL_A = 'https://bunkr.su/f/flaky.mp4';
const URL_B = 'https://bunkr.su/f/kept.mp4';
// Same identity as URL_B with a freshly signed/expired URL.
const URL_B_RESIGNED = 'https://dl.bunkr.cr/file/kept.mp4?token=signed&ex=1';
const URL_C = 'https://bunkr.su/f/other-chat.mp4';

type DownloadCall = { url: string; outputDir: string };

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

// Global serial so status message ids stay unique across notifier instances
// (jobs.status_message_id is UNIQUE, and retry scenarios create several
// notifiers for the same chat).
let notifierSerialCounter = 0;

function buildNotifier(chatId: number) {
  const serial = ++notifierSerialCounter;
  const statuses: string[] = [];
  let deletedCount = 0;
  // Each process() run creates a new job, which needs a fresh status message
  // id even inside the same chat.
  let acceptedCount = 0;
  const notifier = {
    chatId,
    async sendAccepted(): Promise<StatusMessage> {
      acceptedCount += 1;
      return { messageId: serial * 10_000 + acceptedCount };
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {
      deletedCount += 1;
    },
    async confirmStopped(): Promise<void> {},
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

  return { notifier: notifier as unknown as TelegramNotifier, statuses, get deletedCount() { return deletedCount; } };
}

function buildDownloader(options: {
  /** How many initial failures per URL before a success; missing URL = 0. */
  failuresBeforeSuccess?: Record<string, number>;
  alwaysFail?: string[];
}) {
  const calls: DownloadCall[] = [];
  const attemptCount = new Map<string, number>();

  const downloader = {
    async expandUrl(url: string): Promise<string[]> {
      return [url];
    },
    async download(downloadOptions: { url: string; outputDir: string }) {
      calls.push({ url: downloadOptions.url, outputDir: downloadOptions.outputDir });
      const attempt = (attemptCount.get(downloadOptions.url) ?? 0) + 1;
      attemptCount.set(downloadOptions.url, attempt);

      const allowedFailures = options.failuresBeforeSuccess?.[downloadOptions.url] ?? 0;
      if (options.alwaysFail?.includes(downloadOptions.url) || attempt <= allowedFailures) {
        throw new Error(`boom attempt ${attempt}`);
      }

      return {
        filePath: path.join(downloadOptions.outputDir, 'video.mp4'),
        fileSize: 1024,
        title: 'Video OK',
        durationSeconds: 5,
      };
    },
  } as unknown as VideoDownloader;

  return { downloader, calls };
}

function buildProcessor(options: {
  db: BotDatabase;
  workspaceManager: WorkspaceManager;
  downloader: VideoDownloader;
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
    workspaceManager: options.workspaceManager,
    screenshotCount: 0,
    sendVideoInAlbum: false,
    reencodeAnamorphic: false,
    downloadRetries: 3,
    downloadRetryBackoffMs: 5,
    db: options.db,
  });
}

async function waitFor(condition: () => boolean | Promise<boolean>, description = '', timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting: ${description || 'unnamed condition'}`);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return await fsp.stat(candidatePath).then(() => true).catch(() => false);
}

async function main(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  const db = new BotDatabase(`${TMP_DIR}/bot.db`);
  const workspaceManager = new WorkspaceManager(`${TMP_DIR}/workspace`);
  let keptWorkspaceDir: string | undefined;

  // 1) Retries stay in one workspace, and it is removed after success.
  {
    const notifierState = buildNotifier(901);
    const { statuses } = notifierState;
    const { downloader, calls } = buildDownloader({ failuresBeforeSuccess: { [URL_A]: 2 } });
    const processor = buildProcessor({ db, workspaceManager, downloader });

    await processor.process({ notifier: notifierState.notifier, text: URL_A, userId: '1' });
    await waitFor(() => notifierState.deletedCount >= 1, 'scenario 1 success finished');

    check(calls.length === 3, `a flaky download must be attempted 3 times: ${calls.length}`);
    const outputDirs = new Set(calls.map((call) => call.outputDir));
    check(outputDirs.size === 1, `every retry must reuse the same workspace: ${JSON.stringify([...outputDirs])}`);
    check(
      statuses.some((text) => text.startsWith('Attempt 1/3 gagal: ')),
      `retry attempts must be reported to the user: ${JSON.stringify(statuses)}`,
    );
    check(!(await pathExists(calls[0].outputDir)), `a succeeded workspace must be removed`);
    check(
      (db.db.prepare('SELECT resume_dir FROM job_items WHERE url = ? AND status = ?').all(URL_A, 'done') as Array<{ resume_dir: string | null }>).every((row) => row.resume_dir === null),
      `a succeeded item must not keep a resume_dir`,
    );
  }

  // 2) A download that keeps failing keeps its workspace for a later resume.
  {
    const { notifier, statuses } = buildNotifier(902);
    const { downloader, calls } = buildDownloader({ alwaysFail: [URL_B] });
    const processor = buildProcessor({ db, workspaceManager, downloader });

    await processor.process({ notifier, text: URL_B, userId: '1' });
    await waitFor(() => statuses.some((text) => text.startsWith('Link 1/1 gagal: ')), 'scenario 2 failure reported');

    check(calls.length === 3, `the retries must be exhausted: ${calls.length}`);
    check(await pathExists(calls[0].outputDir), `a failed workspace must be kept for a resume attempt`);
    const rows = db.db
      .prepare('SELECT resume_dir FROM job_items WHERE url = ? AND status = ?')
      .all(URL_B, 'failed') as Array<{ resume_dir: string | null }>;
    check(rows.length === 1 && rows[0].resume_dir === calls[0].outputDir, `the failed item must record its resume_dir: ${JSON.stringify(rows)}`);
    keptWorkspaceDir = rows[0].resume_dir ?? undefined;
    check(
      statuses.some((text) => text.includes('Kirim ulang link ini untuk melanjutkan')),
      `the failure status must tell the user to resend the link: ${JSON.stringify(statuses)}`,
    );
  }

  // 3) Resending the same file under a different (re-signed) URL resumes the
  //    kept workspace and finishes it.
  {
    const notifierState = buildNotifier(902);
    const { statuses } = notifierState;
    const { downloader, calls } = buildDownloader({});
    const processor = buildProcessor({ db, workspaceManager, downloader });

    await processor.process({ notifier: notifierState.notifier, text: URL_B_RESIGNED, userId: '1' });
    await waitFor(() => notifierState.deletedCount >= 1, 'scenario 3 resumed success finished');

    check(calls.length === 1, `the resumed download must succeed on the first attempt: ${calls.length}`);
    check(keptWorkspaceDir !== undefined, `the previous scenario must have kept a workspace`);
    check(calls[0].outputDir === keptWorkspaceDir, `the resent link must reuse the kept workspace: ${calls[0].outputDir}`);
    check(!(await pathExists(calls[0].outputDir)), `the resumed workspace must be removed after success`);
    check(
      statuses.some((text) => text.includes('melanjutkan download sebelumnya')),
      `the resume must be visible in the status: ${JSON.stringify(statuses)}`,
    );
    check(
      (db.db.prepare('SELECT resume_dir FROM job_items WHERE url = ?').all(URL_B) as Array<{ resume_dir: string | null }>).every((row) => row.resume_dir === null),
      `claiming the partial must clear the old item's resume_dir`,
    );
  }

  // 4) Resending the same failing link keeps reusing (and then keeping) the
  //    same workspace instead of piling up new empty dirs.
  {
    const notifierState = buildNotifier(902);
    const { statuses } = notifierState;
    const { downloader, calls } = buildDownloader({ alwaysFail: [URL_B] });
    const processor = buildProcessor({ db, workspaceManager, downloader });

    await processor.process({ notifier: notifierState.notifier, text: URL_B, userId: '1' });
    await waitFor(() => statuses.filter((text) => text.startsWith('Link 1/1 gagal: ')).length === 1, 'scenario 4 first failure reported');

    await processor.process({ notifier: notifierState.notifier, text: URL_B, userId: '1' });
    await waitFor(() => statuses.filter((text) => text.startsWith('Link 1/1 gagal: ')).length === 2, 'scenario 4 both failures reported');

    const firstDir = (db.db
      .prepare('SELECT resume_dir FROM job_items WHERE url = ? AND status = ? ORDER BY id DESC LIMIT 1')
      .all(URL_B, 'failed') as Array<{ resume_dir: string | null }>)[0].resume_dir;
    check(firstDir !== null, `the retried item must keep a resume_dir`);
    check(
      calls.every((call) => call.outputDir === firstDir),
      `the resent failing link must resume the same workspace: ${JSON.stringify(calls.map((call) => call.outputDir))}`,
    );
  }

  // 5) Another chat cannot claim another chat's partial.
  {
    const notifierState = buildNotifier(903);
    const { statuses } = notifierState;
    const { downloader, calls } = buildDownloader({ alwaysFail: [URL_C] });
    const processor = buildProcessor({ db, workspaceManager, downloader });

    await processor.process({ notifier: notifierState.notifier, text: URL_C, userId: '1' });
    await waitFor(() => statuses.some((text) => text.startsWith('Link 1/1 gagal: ')), 'scenario 5 first failure reported');
    const otherChatDir = calls[0].outputDir;

    const notifierState2 = buildNotifier(904);
    const { statuses: statuses2 } = notifierState2;
    const { downloader: downloader2, calls: calls2 } = buildDownloader({ failuresBeforeSuccess: { [URL_C]: 0 } });
    const processor2 = buildProcessor({ db, workspaceManager, downloader: downloader2 });

    await processor2.process({ notifier: notifierState2.notifier, text: URL_C, userId: '1' });
    await waitFor(() => notifierState2.deletedCount >= 1, 'scenario 5 resend success finished');

    check(calls2[0].outputDir !== otherChatDir, `another chat must not resume a foreign workspace`);
    check(await pathExists(otherChatDir), `the foreign partial must stay untouched`);
  }

  db.close();
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
