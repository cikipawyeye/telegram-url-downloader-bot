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

      await this.runCommand('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        item.captureSeconds.toFixed(3),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        filePath,
      ]);

      await fsp.access(filePath);

      screenshots.push({
        filePath,
        fileName: item.fileName,
      });
    }

    return screenshots;
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

      const timer = setTimeout(() => {
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
        clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
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
