import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DownloadedVideo } from './utils.js';

export type VideoSegment = {
  filePath: string;
  fileSize: number;
  index: number;
  total: number;
  width?: number;
  height?: number;
};

export class VideoSplitter {
  private readonly commandTimeoutMs: number;
  private readonly maxAttempts = 8;
  private readonly targetSizeRatio = 0.95;

  constructor(options: { commandTimeoutMs: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  async split(video: DownloadedVideo, outputDir: string, maxFileSizeBytes: number): Promise<VideoSegment[]> {
    if (video.fileSize <= maxFileSizeBytes) {
      return [{
        filePath: video.filePath,
        fileSize: video.fileSize,
        index: 1,
        total: 1,
        width: video.width,
        height: video.height,
      }];
    }

    const durationSeconds =
      video.durationSeconds !== undefined && video.durationSeconds > 0
        ? video.durationSeconds
        : await this.probeDuration(video.filePath);

    const targetSegmentSize = Math.max(1, Math.floor(maxFileSizeBytes * this.targetSizeRatio));
    let segmentCount = Math.max(2, Math.ceil(video.fileSize / targetSegmentSize));

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const segments = await this.splitWithSegmentCount({
        durationSeconds,
        maxFileSizeBytes,
        outputDir,
        segmentCount,
        videoPath: video.filePath,
      });

      if (segments.every((segment) => segment.fileSize <= maxFileSizeBytes)) {
        return segments.map((segment, index) => ({
          ...segment,
          index: index + 1,
          total: segments.length,
          // Stream-copied parts keep the source dimensions.
          width: video.width,
          height: video.height,
        }));
      }

      segmentCount += 1;
    }

    throw new Error('Video terlalu besar untuk dipecah menjadi bagian yang aman dikirim ke Telegram.');
  }

  private async splitWithSegmentCount(options: {
    durationSeconds: number;
    maxFileSizeBytes: number;
    outputDir: string;
    segmentCount: number;
    videoPath: string;
  }): Promise<VideoSegment[]> {
    const segmentsDir = path.join(options.outputDir, `segments-${String(options.segmentCount).padStart(3, '0')}`);
    await fsp.rm(segmentsDir, { recursive: true, force: true });
    await fsp.mkdir(segmentsDir, { recursive: true });

    const segmentTimeSeconds = Math.max(1, options.durationSeconds / options.segmentCount);
    const outputPattern = path.join(segmentsDir, 'part-%03d.mp4');

    await this.runCommand('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      options.videoPath,
      '-map',
      '0',
      '-c',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      segmentTimeSeconds.toFixed(3),
      '-segment_format',
      'mp4',
      '-segment_format_options',
      'movflags=+faststart',
      '-reset_timestamps',
      '1',
      outputPattern,
    ]);

    const files = (await fsp.readdir(segmentsDir))
      .filter((file) => file.endsWith('.mp4'))
      .sort();

    if (files.length === 0) {
      throw new Error('Gagal memecah video: tidak ada file part yang dibuat.');
    }

    const segments: VideoSegment[] = [];

    for (const [index, file] of files.entries()) {
      const filePath = path.join(segmentsDir, file);
      const stat = await fsp.stat(filePath);

      if (stat.size === 0) {
        continue;
      }

      segments.push({
        filePath,
        fileSize: stat.size,
        index: index + 1,
        total: files.length,
      });
    }

    if (segments.length === 0) {
      throw new Error('Gagal memecah video: semua file part kosong.');
    }

    const oversizedSegment = segments.find((segment) => segment.fileSize > options.maxFileSizeBytes);

    if (oversizedSegment && segments.length === 1) {
      throw new Error('Video tidak dapat dipecah tanpa re-encode karena struktur keyframe terlalu jarang.');
    }

    return segments;
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
      throw new Error('Durasi video tidak dapat dibaca untuk memecah video.');
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
