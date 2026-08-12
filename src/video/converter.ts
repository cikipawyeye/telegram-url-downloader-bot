import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DownloadedVideo } from './utils.js';

export type ConvertedVideo = DownloadedVideo & {
  filePath: string;
  fileSize: number;
  width: number;
  height: number;
};

export class VideoConverter {
  private readonly commandTimeoutMs: number;

  constructor(options: { commandTimeoutMs: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  /**
   * Re-encodes the given video to a target height (kept within the source
   * height to avoid upscaling), preserving aspect ratio. The output uses
   * H.264 + AAC + yuv420p + faststart so it is small and streamable in
   * Telegram.
   */
  async convert(options: {
    video: DownloadedVideo;
    outputDir: string;
    targetHeight: number;
    onProgress?: (percent: number) => void;
  }): Promise<ConvertedVideo> {
    const sourceHeight = options.video.height;
    const effectiveTargetHeight =
      sourceHeight !== undefined && sourceHeight > 0
        ? Math.min(options.targetHeight, sourceHeight)
        : options.targetHeight;

    const outputFilePath = path.join(options.outputDir, 'converted.mp4');

    await this.runCommand('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-stats_period',
      '1',
      '-i',
      options.video.filePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      `scale=-2:min(${effectiveTargetHeight}\\,ih)`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      '-max_muxing_queue_size',
      '1024',
      outputFilePath,
    ], options.onProgress);

    const stat = await fsp.stat(outputFilePath);
    const dimensions = await this.probeDimensions(outputFilePath);

    return {
      ...options.video,
      filePath: outputFilePath,
      fileSize: stat.size,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  private async probeDimensions(videoPath: string): Promise<{ width: number; height: number }> {
    const output = await this.runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      videoPath,
    ]);

    try {
      const parsed = JSON.parse(output) as {
        streams?: Array<{ width?: number | string; height?: number | string }>;
      };
      const stream = parsed.streams?.[0];
      const width = Number(stream?.width);
      const height = Number(stream?.height);

      return {
        width: Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
        height: Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
      };
    } catch (error) {
      console.error('Failed to parse converted video dimensions:', error);
      return { width: 0, height: 0 };
    }
  }

  private runCommand(command: string, args: string[], onProgress?: (percent: number) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let totalSeconds: number | null = null;

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
        const text = String(chunk);
        stderr += text;

        if (!onProgress) {
          return;
        }

        const timeMatch = text.match(/time=(\d+):(\d+):(\d+)/);
        const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)/);

        if (durationMatch) {
          totalSeconds =
            Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
        }

        if (timeMatch && totalSeconds && totalSeconds > 0) {
          const currentSeconds =
            Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
          onProgress(Math.min(100, Math.round((currentSeconds / totalSeconds) * 100)));
        }
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
