import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildScreenshotPlan, type VideoScreenshot } from './utils.js';

export type GenerateScreenshotsOptions = {
  videoPath: string;
  outputDir: string;
  durationSeconds?: number;
  count: number;
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
  }: GenerateScreenshotsOptions): Promise<VideoScreenshot[]> {
    const screenshotsDir = path.join(outputDir, 'screenshots');
    await fsp.mkdir(screenshotsDir, { recursive: true });

    const resolvedDurationSeconds =
      durationSeconds !== undefined && durationSeconds > 0
        ? durationSeconds
        : await this.probeDuration(videoPath);

    const screenshotPlan = buildScreenshotPlan(resolvedDurationSeconds, count);
    const screenshots: VideoScreenshot[] = [];

    for (const item of screenshotPlan) {
      const filePath = path.join(screenshotsDir, item.fileName);
      const captured = await this.captureScreenshot({
        durationSeconds: resolvedDurationSeconds,
        filePath,
        preferredCaptureSeconds: item.captureSeconds,
        videoPath,
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

  private async captureScreenshot(options: {
    durationSeconds: number;
    filePath: string;
    preferredCaptureSeconds: number;
    videoPath: string;
  }): Promise<boolean> {
    const captureTimes = this.buildCaptureFallbacks(
      options.preferredCaptureSeconds,
      options.durationSeconds,
    );

    for (const captureSeconds of captureTimes) {
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
        '-q:v',
        '2',
        options.filePath,
      ]);

      if (await fileExistsWithContent(options.filePath)) {
        return true;
      }
    }

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

  private async probeDuration(videoPath: string): Promise<number> {
    const output = await this.runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);

    const durationSeconds = Number(output.trim());

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Durasi video tidak dapat dibaca untuk membuat screenshot.');
    }

    return durationSeconds;
  }

  private async runCommand(command: string, args: string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timeout setelah ${Math.round(this.commandTimeoutMs / 1000)} detik.`));
      }, this.commandTimeoutMs);

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
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);

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

async function fileExistsWithContent(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size > 0;
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
