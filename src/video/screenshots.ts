import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DownloadCancelledError } from './downloader.js';
import { buildScreenshotPlan, type VideoScreenshot, type VideoThumbnail } from './utils.js';

const TELEGRAM_THUMBNAIL_FILE_NAME = 'thumbnail.jpg';
const TELEGRAM_THUMBNAIL_MAX_BYTES = 200 * 1024;
const TELEGRAM_THUMBNAIL_MAX_DIMENSION = 320;
const SCREENSHOT_MAX_DIMENSION = 1920;
const TELEGRAM_THUMBNAIL_QUALITY_VALUES = [4, 8, 12, 16, 20, 24, 28, 31];

/**
 * Convert non-square source pixels to real image dimensions before Telegram
 * sees the JPG. Only applied when the stream actually has a non-square SAR —
 * running this unconditionally would rescale every frame (e.g. SAR 9:16 on a
 * 1080x1080 stream produces a 6075x1080 frame) and burn CPU for nothing.
 */
export function buildPixelAspectFilter(sar: string | undefined): string | undefined {
  if (!sar || sar === 'N/A' || sar === '0:1' || sar === '1:1') {
    return undefined;
  }

  return 'scale=trunc(iw*sar/2)*2:ih,setsar=1';
}

export type GenerateScreenshotsOptions = {
  videoPath: string;
  outputDir: string;
  durationSeconds?: number;
  count: number;
  signal?: AbortSignal;
};

export type GenerateThumbnailOptions = {
  videoPath: string;
  outputDir: string;
  durationSeconds?: number;
  signal?: AbortSignal;
};

export class VideoScreenshotGenerator {
  private readonly commandTimeoutMs: number;

  constructor(options: { commandTimeoutMs: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  async generate({
    count,
    durationSeconds,
    outputDir,
    videoPath,
    signal,
  }: GenerateScreenshotsOptions): Promise<VideoScreenshot[]> {
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    const screenshotsDir = path.join(outputDir, 'screenshots');
    await fsp.mkdir(screenshotsDir, { recursive: true });

    const mediaInfo = await this.probeMediaInfo(videoPath, signal);
    const resolvedDurationSeconds =
      durationSeconds !== undefined && durationSeconds > 0
        ? durationSeconds
        : mediaInfo.durationSeconds ?? 0;

    if (!(resolvedDurationSeconds > 0)) {
      throw new Error('Durasi video tidak dapat dibaca untuk membuat screenshot.');
    }

    const aspectFilter = buildPixelAspectFilter(mediaInfo.sampleAspectRatio);
    const screenshotPlan = buildScreenshotPlan(resolvedDurationSeconds, count);
    const screenshots: VideoScreenshot[] = [];

    for (const item of screenshotPlan) {
      if (signal?.aborted) {
        throw new DownloadCancelledError();
      }

      const filePath = path.join(screenshotsDir, item.fileName);
      const captured = await this.captureScreenshot({
        aspectFilter,
        durationSeconds: resolvedDurationSeconds,
        filePath,
        preferredCaptureSeconds: item.captureSeconds,
        videoPath,
        signal,
      });

      if (!captured) {
        throw new Error(`Gagal membuat screenshot ${item.fileName}: frame video tidak ditemukan.`);
      }

      screenshots.push({
        filePath,
        fileName: item.fileName,
      });
    }

    return screenshots;
  }

  async generateThumbnail({
    durationSeconds,
    outputDir,
    videoPath,
    signal,
  }: GenerateThumbnailOptions): Promise<VideoThumbnail> {
    if (signal?.aborted) {
      throw new DownloadCancelledError();
    }

    await fsp.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, TELEGRAM_THUMBNAIL_FILE_NAME);
    const mediaInfo = await this.probeMediaInfo(videoPath, signal);
    const resolvedDurationSeconds =
      durationSeconds !== undefined && durationSeconds > 0
        ? durationSeconds
        : mediaInfo.durationSeconds ?? 0;

    if (!(resolvedDurationSeconds > 0)) {
      throw new Error('Durasi video tidak dapat dibaca untuk membuat thumbnail.');
    }

    const captured = await this.captureThumbnail({
      aspectFilter: buildPixelAspectFilter(mediaInfo.sampleAspectRatio),
      durationSeconds: resolvedDurationSeconds,
      filePath,
      preferredCaptureSeconds: resolvedDurationSeconds * 0.5,
      videoPath,
      signal,
    });

    if (!captured) {
      throw new Error('Gagal membuat thumbnail: frame video tidak ditemukan atau file lebih dari 200 KB.');
    }

    return {
      filePath,
      fileName: TELEGRAM_THUMBNAIL_FILE_NAME,
    };
  }

  private async captureScreenshot(options: {
    aspectFilter?: string;
    durationSeconds: number;
    filePath: string;
    preferredCaptureSeconds: number;
    videoPath: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const captureTimes = this.buildCaptureFallbacks(
      options.preferredCaptureSeconds,
      options.durationSeconds,
    );
    const videoFilter = [
      options.aspectFilter,
      `scale=min(${SCREENSHOT_MAX_DIMENSION}\\,iw):-2`,
    ].filter(Boolean).join(',');

    for (const captureSeconds of captureTimes) {
      if (options.signal?.aborted) {
        throw new DownloadCancelledError();
      }

      await fsp.rm(options.filePath, { force: true });

      await this.runCommand('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        captureSeconds.toFixed(3),
        '-i',
        options.videoPath,
        '-frames:v',
        '1',
        '-vf',
        videoFilter,
        '-q:v',
        '2',
        options.filePath,
      ], options.signal);

      if (await fileExistsWithContent(options.filePath)) {
        return true;
      }
    }

    return false;
  }

  private async captureThumbnail(options: {
    aspectFilter?: string;
    durationSeconds: number;
    filePath: string;
    preferredCaptureSeconds: number;
    videoPath: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const captureTimes = this.buildCaptureFallbacks(
      options.preferredCaptureSeconds,
      options.durationSeconds,
    );
    const candidatePaths = TELEGRAM_THUMBNAIL_QUALITY_VALUES.map(
      (quality) => `${options.filePath}.q${quality}.jpg`,
    );

    // One decode + scale produces every quality variant in a single ffmpeg
    // process instead of re-decoding the frame once per quality value.
    // ponytail: per-output `-update` needs ffmpeg >= 5.1; fall back to the
    // one-command-per-quality loop if older builds ever matter.
    for (const captureSeconds of captureTimes) {
      if (options.signal?.aborted) {
        throw new DownloadCancelledError();
      }

      await fsp.rm(options.filePath, { force: true });
      await Promise.all(candidatePaths.map((candidate) => fsp.rm(candidate, { force: true })));

      const outputArgs = TELEGRAM_THUMBNAIL_QUALITY_VALUES.flatMap((quality, index) => [
        '-map',
        '0:v:0',
        '-update',
        '1',
        '-frames:v',
        '1',
        '-q:v',
        String(quality),
        candidatePaths[index],
      ]);

      const videoFilter = [
        options.aspectFilter,
        `scale=${TELEGRAM_THUMBNAIL_MAX_DIMENSION}:${TELEGRAM_THUMBNAIL_MAX_DIMENSION}:force_original_aspect_ratio=decrease`,
      ].filter(Boolean).join(',');

      await this.runCommand('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        captureSeconds.toFixed(3),
        '-i',
        options.videoPath,
        '-vf',
        videoFilter,
        ...outputArgs,
      ], options.signal);

      // Prefer the highest quality that fits Telegram's size cap.
      for (const index of TELEGRAM_THUMBNAIL_QUALITY_VALUES.keys()) {
        if (await fileExistsWithContent(candidatePaths[index], TELEGRAM_THUMBNAIL_MAX_BYTES)) {
          await fsp.rename(candidatePaths[index], options.filePath);
          await Promise.all(candidatePaths.map((candidate) => fsp.rm(candidate, { force: true })));
          return true;
        }
      }
    }

    await fsp.rm(options.filePath, { force: true });
    await Promise.all(candidatePaths.map((candidate) => fsp.rm(candidate, { force: true })));
    return false;
  }

  private buildCaptureFallbacks(preferredCaptureSeconds: number, durationSeconds: number): number[] {
    const maxCaptureSeconds = Math.max(0, durationSeconds - Math.min(1, durationSeconds / 20));
    const candidates = [
      preferredCaptureSeconds,
      preferredCaptureSeconds - 1,
      durationSeconds * 0.75,
      durationSeconds * 0.5,
      durationSeconds * 0.25,
      Math.min(1, maxCaptureSeconds),
      0,
    ];

    return Array.from(new Set(
      candidates
        .map((seconds) => Math.min(maxCaptureSeconds, Math.max(0, seconds)))
        .map((seconds) => seconds.toFixed(3)),
    )).map(Number);
  }

  private async probeMediaInfo(videoPath: string, signal?: AbortSignal): Promise<{
    durationSeconds?: number;
    sampleAspectRatio?: string;
  }> {
    const output = await this.runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=sample_aspect_ratio:format=duration',
      '-of',
      'json',
      videoPath,
    ], signal);

    let parsed: {
      streams?: Array<{ sample_aspect_ratio?: string }>;
      format?: { duration?: string };
    };

    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error('Durasi video tidak dapat dibaca untuk membuat screenshot.');
    }

    const durationRaw = Number(parsed.format?.duration);

    return {
      durationSeconds: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined,
      sampleAspectRatio: parsed.streams?.[0]?.sample_aspect_ratio,
    };
  }

  private async runCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(new DownloadCancelledError());
      };

      timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(new Error(`${command} timeout setelah ${Math.round(this.commandTimeoutMs / 1000)} detik.`));
      }, this.commandTimeoutMs);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (code === 0) {
          resolve(stdout);
          return;
        }

        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
        reject(new Error(output || `${command} exited with code ${code}`));
      });
    });
  }
}

async function fileExistsWithContent(filePath: string, maxBytes?: number): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size > 0 && (maxBytes === undefined || stat.size < maxBytes);
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
