/**
 * Runnable check for the Google Drive / gdown path: Drive URL detection (with
 * folder detection), the tqdm progress-line parser used to feed the Telegram
 * status message, the gdown binary probe, and an end-to-end download() run
 * against a fake `gdown` binary (spawn wiring, progress callbacks, result
 * resolution and abort) so no real download happens.
 *
 * Run with: npx tsx scripts/gdown-check.ts
 */
import fsp from 'node:fs/promises';
import type { YtDlp } from 'ytdlp-nodejs';
import {
  DownloadCancelledError,
  isGoogleDriveFolderUrl,
  isGoogleDriveUrl,
  parseGdownProgressLine,
  resolveGdownBinary,
  VideoDownloader,
} from '../src/video/downloader.js';

const TMP_DIR = '/tmp/gdown-check';

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function checkDeepEqual(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  );
}

function checkUrlDetection(): void {
  const driveUrls = [
    'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing',
    'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp',
    'https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOp&export=download',
    'https://docs.google.com/uc?id=1AbCdEfGhIjKlMnOp',
    'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOp&export=download',
    'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing',
    'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp',
  ];

  for (const url of driveUrls) {
    check(isGoogleDriveUrl(url), `a Drive URL must be detected: ${url}`);
  }

  for (const url of [
    'https://www.youtube.com/watch?v=abc',
    'https://example.com/file/d/abc/view',
    'https://drive.google.com.evil.com/file/d/abc/view',
    'https://notdrive.google.com/file/d/abc/view',
    'https://dl.bunkr.cr/file/abc',
    'not a url',
  ]) {
    check(!isGoogleDriveUrl(url), `a non-Drive URL must not be detected: ${url}`);
  }

  check(isGoogleDriveFolderUrl('https://drive.google.com/drive/folders/1AbC'), 'a /drive/folders URL is a folder');
  check(isGoogleDriveFolderUrl('https://drive.google.com/drive/u/0/folders/1AbC'), 'a /drive/u/0/folders URL is a folder');
  check(!isGoogleDriveFolderUrl('https://drive.google.com/file/d/1AbC/view'), 'a /file/d URL is not a folder');
  check(!isGoogleDriveFolderUrl('https://drive.google.com/open?id=1AbC'), 'an /open?id URL is not a folder');
}

function checkProgressParsing(): void {
  // Lines captured from a real gdown run (see the tqdm format).
  const full = parseGdownProgressLine('  1%|          | 5.24M/499M [00:09<07:52, 1.04MB/s]');
  checkDeepEqual(
    full,
    {
      status: 'downloading',
      downloadedBytes: 5_240_000,
      totalBytes: 499_000_000,
      speedBytesPerSecond: 1_040_000,
      etaSeconds: 472,
      percent: 1,
    },
    'a full tqdm line must parse percent/bytes/speed/eta',
  );

  const mid = parseGdownProgressLine(' 12%|█▎         | 14.7M/499M [00:11<01:48, 4.48MB/s]');
  checkDeepEqual(
    mid,
    {
      status: 'downloading',
      downloadedBytes: 14_700_000,
      totalBytes: 499_000_000,
      speedBytesPerSecond: 4_480_000,
      etaSeconds: 108,
      percent: 12,
    },
    'a mid-download tqdm line must parse',
  );

  const start = parseGdownProgressLine('  0%|          | 0.00/499M [00:00<?, ?B/s]');
  checkDeepEqual(
    start,
    {
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: 499_000_000,
      speedBytesPerSecond: undefined,
      etaSeconds: undefined,
      percent: 0,
    },
    'the initial 0% line must parse without speed/eta',
  );

  const hours = parseGdownProgressLine(' 50%|█████     | 1.00G/2.00G [01:02:03<01:00:00, 8.00MiB/s]');
  checkDeepEqual(
    hours,
    {
      status: 'downloading',
      downloadedBytes: 1_000_000_000,
      totalBytes: 2_000_000_000,
      speedBytesPerSecond: 8 * 1_048_576,
      etaSeconds: 3600,
      percent: 50,
    },
    'h:mm:ss eta and IEC speed suffix must parse',
  );

  for (const line of ['Downloading...', 'To: /tmp/file.mp4', '']) {
    check(parseGdownProgressLine(line) === undefined, `a non-progress line must be ignored: "${line}"`);
  }
}

const FAKE_GDOWN = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');

if (process.argv.includes('--version')) {
  process.exit(0);
}

process.stderr.write('Downloading...\\n');
process.stderr.write('To: ' + process.cwd() + '/sample-video.mp4\\n');

if (process.env.FAKE_GDOWN_MODE === 'hang') {
  process.stderr.write('  1%|          | 1.00k/10.0k [00:00<09:59, 10B/s]\\r');
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(' 50%|\\u2588\\u2588\\u2588\\u2588\\u2588     | 5.00k/10.0k [00:00<00:01, 9.00kB/s]\\r');
  fs.writeFileSync(process.cwd() + '/sample-video.mp4', Buffer.alloc(1000));
  process.stderr.write(' 100%|\\u2588\\u2588\\u2588\\u2588\\u2588\\u2588\\u2588\\u2588\\u2588\\u2588| 10.0k/10.0k [00:01<00:00, 9.50kB/s]\\r');
}
`;

async function checkDownloadWithFakeGdown(): Promise<void> {
  const binDir = `${TMP_DIR}/bin`;
  const outputDir = `${TMP_DIR}/out`;
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.writeFile(`${binDir}/gdown`, FAKE_GDOWN, { mode: 0o755 });

  // Make the fake binary win the PATH resolution; the real binary name stays
  // the same, so download() still goes through its normal routing.
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const downloader = new VideoDownloader({
    downloadTimeoutMs: 60_000,
    ytdlp: {} as YtDlp,
  });

  const progressEvents: unknown[] = [];
  const result = await downloader.download({
    url: 'https://drive.google.com/uc?id=1FakeDriveFileId',
    outputDir,
    onProgress: (progress) => progressEvents.push(progress),
  });

  check(result.filePath === `${outputDir}/sample-video.mp4`, `the fake download must resolve its file: ${result.filePath}`);
  check(result.fileSize === 1000, `the resolved file must keep its size: ${result.fileSize}`);
  check(result.title === 'sample-video.mp4', `the "To:" line must become the title: ${result.title}`);
  check(
    progressEvents.some(
      (progress) =>
        typeof progress === 'object' &&
        progress !== null &&
        (progress as { percent?: number }).percent === 50 &&
        (progress as { downloadedBytes?: number }).downloadedBytes === 5_000,
    ),
    `a 50% tqdm line must reach onProgress: ${JSON.stringify(progressEvents)}`,
  );
  check(
    progressEvents.some(
      (progress) =>
        typeof progress === 'object' &&
        progress !== null &&
        (progress as { status?: string }).status === 'finished',
    ),
    `a finished event must be emitted last: ${JSON.stringify(progressEvents)}`,
  );

  // Abort: a hanging gdown run must be killed and surface as cancellation.
  const hangOutputDir = `${TMP_DIR}/out-hang`;
  const controller = new AbortController();
  process.env.FAKE_GDOWN_MODE = 'hang';
  const hangPromise = downloader.download({
    url: 'https://drive.google.com/uc?id=1FakeDriveFileId',
    outputDir: hangOutputDir,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await hangPromise.then(
    () => {
      throw new Error('the hanging download should have been aborted');
    },
    (error: unknown) => {
      check(error instanceof DownloadCancelledError, `an aborted download must raise DownloadCancelledError: ${error instanceof Error ? error.message : error}`);
    },
  );

  await fsp.rm(TMP_DIR, { recursive: true, force: true });
}

async function main(): Promise<void> {
  checkUrlDetection();
  checkProgressParsing();

  const gdownBinary = await resolveGdownBinary();
  console.log(`gdown binary probe: ${gdownBinary ?? 'not found (yt-dlp fallback stays active)'}`);

  await checkDownloadWithFakeGdown();

  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
