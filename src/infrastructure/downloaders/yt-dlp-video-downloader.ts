import fsp from 'node:fs/promises';
import path from 'node:path';
import { type DownloadFinishResult, type VideoProgress as YtDlpVideoProgress, YtDlp } from 'ytdlp-nodejs';
import type { DownloadVideoRequest, VideoDownloader } from '../../application/ports/video-downloader.js';
import type { DownloadedVideo, VideoDownloadProgress } from '../../domain/video.js';

type YtDlpVideoDownloaderDependencies = {
  downloadTimeoutMs: number;
  ytdlp: YtDlp;
};

export class YtDlpVideoDownloader implements VideoDownloader {
  private readonly downloadTimeoutMs: number;
  private readonly ytdlp: YtDlp;

  constructor(dependencies: YtDlpVideoDownloaderDependencies) {
    this.downloadTimeoutMs = dependencies.downloadTimeoutMs;
    this.ytdlp = dependencies.ytdlp;
  }

  async download(request: DownloadVideoRequest): Promise<DownloadedVideo> {
    const { onProgress, outputDir, url } = request;
    const outputTemplate = path.join(outputDir, '%(title).120s [%(id)s].%(ext)s');
    const download = this.ytdlp.download(url, {
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
    const title = result.info[0]?.title ?? 'video';

    if (directFilePath) {
      const stat = await fsp.stat(directFilePath);

      return {
        filePath: directFilePath,
        fileSize: stat.size,
        title,
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
    };
  }
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
