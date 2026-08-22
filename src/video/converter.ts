import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DownloadCancelledError } from './downloader.js';
import { buildPixelAspectFilter } from './screenshots.js';
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
   * Re-encodes the given video so its *short edge* does not exceed the target
   * height (kept within the source size to avoid upscaling), preserving aspect
   * ratio. For landscape/square sources the short edge is the height; for
   * portrait sources it is the width, so the filter caps whichever axis keeps
   * the most detail. The output uses H.264 + AAC + yuv420p + faststart so it
   * is small and streamable in Telegram.
   */
  async convert(options: {
    video: DownloadedVideo;
    outputDir: string;
    targetHeight: number;
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
  }): Promise<ConvertedVideo> {
    const sourceWidth = options.video.width;
    const sourceHeight = options.video.height;

    // A "720p" target means the *short edge* of the video is capped at 720.
    // For landscape (or square) sources the short edge is the height, but for
    // portrait sources it is the width. If we always clamp the height, a
    // 720x1280 portrait video collapses to 405x720 and loses ~68% of its
    // pixels. Detect the orientation and cap the short edge so portrait
    // quality is preserved.
    const isPortrait =
      sourceWidth !== undefined &&
      sourceWidth > 0 &&
      sourceHeight !== undefined &&
      sourceHeight > sourceWidth;

    let scaleFilter: string;
    if (isPortrait) {
      const effectiveTargetWidth =
        sourceWidth !== undefined && sourceWidth > 0
          ? Math.min(options.targetHeight, sourceWidth)
          : options.targetHeight;
      scaleFilter = `scale=min(${effectiveTargetWidth}\\,iw):-2`;
    } else {
      const effectiveTargetHeight =
        sourceHeight !== undefined && sourceHeight > 0
          ? Math.min(options.targetHeight, sourceHeight)
          : options.targetHeight;
      scaleFilter = `scale=-2:min(${effectiveTargetHeight}\\,ih)`;
    }

    // Non-square source pixels (anamorphic) must be baked into real dimensions
    // before scaling, otherwise Telegram clients ignore the SAR tag and show
    // the video stretched.
    const aspectFilter = buildPixelAspectFilter(
      await this.probeSampleAspectRatio(options.video.filePath),
    );
    const videoFilter = [aspectFilter, scaleFilter].filter(Boolean).join(',');

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
      videoFilter,
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
    ], options.onProgress, options.signal);

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

  private async probeSampleAspectRatio(videoPath: string): Promise<string | undefined> {
    let output: string;
    try {
      output = await this.runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=sample_aspect_ratio',
        '-of',
        'json',
        videoPath,
      ]);
    } catch {
      return undefined;
    }

    try {
      const parsed = JSON.parse(output) as {
        streams?: Array<{ sample_aspect_ratio?: string }>;
      };
      return parsed.streams?.[0]?.sample_aspect_ratio;
    } catch {
      return undefined;
    }
  }

  private runCommand(
    command: string,
    args: string[],
    onProgress?: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let totalSeconds: number | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
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

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
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
