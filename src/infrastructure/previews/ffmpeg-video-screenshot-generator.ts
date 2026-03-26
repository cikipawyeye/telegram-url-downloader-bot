import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GenerateVideoScreenshotsRequest, GeneratedVideoScreenshot, VideoScreenshotGenerator } from '../../application/ports/video-screenshot-generator.js';
import { buildScreenshotPlan } from '../../domain/video.js';

type FfmpegVideoScreenshotGeneratorDependencies = {
  commandTimeoutMs: number;
};

export class FfmpegVideoScreenshotGenerator implements VideoScreenshotGenerator {
  private readonly commandTimeoutMs: number;

  constructor(dependencies: FfmpegVideoScreenshotGeneratorDependencies) {
    this.commandTimeoutMs = dependencies.commandTimeoutMs;
  }

  async generate(request: GenerateVideoScreenshotsRequest): Promise<GeneratedVideoScreenshot[]> {
    const outputDir = path.join(request.outputDir, 'screenshots');
    await fsp.mkdir(outputDir, { recursive: true });

    const durationSeconds =
      request.durationSeconds !== undefined && request.durationSeconds > 0
        ? request.durationSeconds
        : await this.probeDuration(request.videoPath);
    const screenshotPlan = buildScreenshotPlan(durationSeconds, request.count);
    const screenshots: GeneratedVideoScreenshot[] = [];

    for (const item of screenshotPlan) {
      const filePath = path.join(outputDir, item.fileName);

      await this.runCommand('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-ss',
        item.captureSeconds.toFixed(3),
        '-i',
        request.videoPath,
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
        caption: item.caption,
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
