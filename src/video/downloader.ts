import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type DownloadFinishResult, type VideoProgress as YtDlpVideoProgress, YtDlp } from 'ytdlp-nodejs';
import { type DownloadedVideo, type VideoDownloadProgress } from './utils.js';

const BEST_AVAILABLE_VIDEO_FORMAT = 'bestvideo*+bestaudio/best';
const METADATA_PROBE_TIMEOUT_MS = 30_000;

export type DownloadVideoOptions = {
  url: string;
  outputDir: string;
  onProgress?: (progress: VideoDownloadProgress) => void;
};

type VideoMetadata = {
  durationSeconds?: number;
  width?: number;
  height?: number;
};

type FfprobeMetadataOutput = {
  streams?: Array<{
    width?: number | string;
    height?: number | string;
  }>;
  format?: {
    duration?: number | string;
  };
};

export class VideoDownloader {
  private readonly downloadTimeoutMs: number;
  private readonly ytdlp: YtDlp;

  constructor(options: { downloadTimeoutMs: number; ytdlp: YtDlp }) {
    this.downloadTimeoutMs = options.downloadTimeoutMs;
    this.ytdlp = options.ytdlp;
  }

  async download({ onProgress, outputDir, url }: DownloadVideoOptions): Promise<DownloadedVideo> {
    const outputTemplate = path.join(outputDir, 'download.%(ext)s');
    const download = this.ytdlp.download(url, {
      format: BEST_AVAILABLE_VIDEO_FORMAT,
      jsRuntime: '',
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      output: outputTemplate,
      progressDelta: 2,
    });

    if (onProgress) {
      download.on('progress', (progress) => {
        onProgress(mapProgress(progress));
      });
    }

    const result = await this.runWithTimeout(download);
    return await this.resolveDownloadedVideo(result, outputDir);
  }

  private async runWithTimeout(download: ReturnType<YtDlp['download']>): Promise<DownloadFinishResult> {
    return await new Promise<DownloadFinishResult>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        download.kill('SIGKILL');
        reject(new Error(`Proses download timeout setelah ${Math.round(this.downloadTimeoutMs / 1000)} detik.`));
      }, this.downloadTimeoutMs);

      void download.run().then(
        (result) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async resolveDownloadedVideo(
    result: DownloadFinishResult,
    outputDir: string,
  ): Promise<DownloadedVideo> {
    const directFilePath = result.filePaths[0] || result.info[0]?.filepath;
    const info = result.info[0];
    const title = info?.title ?? 'video';

    if (directFilePath) {
      const stat = await fsp.stat(directFilePath);
      const metadata = await this.resolveVideoMetadata(directFilePath, {
        durationSeconds: normalizePositiveNumber(info?.duration),
        width: readPositiveIntegerField(info, 'width'),
        height: readPositiveIntegerField(info, 'height'),
      });

      return {
        filePath: directFilePath,
        fileSize: stat.size,
        title,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
      };
    }

    return await this.resolveDownloadedVideoFromDirectory(outputDir, title);
  }

  private async resolveDownloadedVideoFromDirectory(
    outputDir: string,
    title: string,
  ): Promise<DownloadedVideo> {
    const files = await fsp.readdir(outputDir);
    const candidates = files
      .filter((file) => !file.endsWith('.part'))
      .map((file) => path.join(outputDir, file));

    if (candidates.length === 0) {
      throw new Error('File hasil download tidak ditemukan.');
    }

    let bestFile = candidates[0];
    let bestStat = await fsp.stat(bestFile);

    for (const file of candidates.slice(1)) {
      const stat = await fsp.stat(file);

      if (stat.size > bestStat.size) {
        bestFile = file;
        bestStat = stat;
      }
    }

    return {
      filePath: bestFile,
      fileSize: bestStat.size,
      title,
      ...await this.resolveVideoMetadata(bestFile, {}),
    };
  }

  private async resolveVideoMetadata(filePath: string, metadata: VideoMetadata): Promise<VideoMetadata> {
    if (metadata.durationSeconds && metadata.width && metadata.height) {
      return metadata;
    }

    const probedMetadata = await this.tryProbeVideoMetadata(filePath);

    return {
      durationSeconds: metadata.durationSeconds ?? probedMetadata.durationSeconds,
      width: metadata.width ?? probedMetadata.width,
      height: metadata.height ?? probedMetadata.height,
    };
  }

  private async tryProbeVideoMetadata(filePath: string): Promise<VideoMetadata> {
    try {
      const output = await this.runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:format=duration',
        '-of',
        'json',
        filePath,
      ]);

      const metadata = JSON.parse(output) as FfprobeMetadataOutput;
      const videoStream = metadata.streams?.find((stream) => (
        normalizePositiveInteger(stream.width) !== undefined
          && normalizePositiveInteger(stream.height) !== undefined
      ));

      return {
        durationSeconds: normalizePositiveNumber(metadata.format?.duration),
        width: normalizePositiveInteger(videoStream?.width),
        height: normalizePositiveInteger(videoStream?.height),
      };
    } catch (error) {
      console.error('Failed to probe video metadata:', error);
      return {};
    }
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
        reject(new Error(`${command} timeout setelah ${Math.round(METADATA_PROBE_TIMEOUT_MS / 1000)} detik.`));
      }, METADATA_PROBE_TIMEOUT_MS);

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

function readPositiveIntegerField(source: unknown, fieldName: string): number | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  return normalizePositiveInteger((source as Record<string, unknown>)[fieldName]);
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'string' ? Number(value) : value;

  if (typeof numberValue !== 'number' || !Number.isFinite(numberValue) || numberValue <= 0) {
    return undefined;
  }

  return numberValue;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numberValue = normalizePositiveNumber(value);

  if (numberValue === undefined) {
    return undefined;
  }

  return Math.round(numberValue);
}

function mapProgress(progress: YtDlpVideoProgress): VideoDownloadProgress {
  return {
    status: progress.status,
    downloadedBytes: progress.downloaded,
    totalBytes: progress.total,
    speedBytesPerSecond: progress.speed,
    etaSeconds: progress.eta,
    percent: progress.percentage,
  };
}
