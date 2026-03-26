import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VideoDownloader } from '../../application/ports/video-downloader.js';
import type { DownloadedVideo } from '../../domain/video.js';
import { CommandRunner } from '../process/command-runner.js';

type YtDlpVideoDownloaderDependencies = {
  commandRunner: CommandRunner;
  downloadTimeoutMs: number;
};

export class YtDlpVideoDownloader implements VideoDownloader {
  private readonly commandRunner: CommandRunner;
  private readonly downloadTimeoutMs: number;

  constructor(dependencies: YtDlpVideoDownloaderDependencies) {
    this.commandRunner = dependencies.commandRunner;
    this.downloadTimeoutMs = dependencies.downloadTimeoutMs;
  }

  async download(url: string, outputDir: string): Promise<DownloadedVideo> {
    const outputTemplate = path.join(outputDir, '%(title).120s [%(id)s].%(ext)s');

    const metadata = await this.commandRunner.runJson('yt-dlp', [
      '--dump-single-json',
      '--no-playlist',
      url,
    ]);

    const title = typeof metadata.title === 'string' ? metadata.title : 'video';
    const extractorError = metadata._type === 'error' ? metadata.error : undefined;

    if (extractorError) {
      throw new Error(String(extractorError));
    }

    await this.commandRunner.run(
      'yt-dlp',
      [
        '--no-playlist',
        '--merge-output-format',
        'mp4',
        '-o',
        outputTemplate,
        url,
      ],
      this.downloadTimeoutMs,
    );

    return await this.resolveDownloadedVideo(outputDir, title);
  }

  private async resolveDownloadedVideo(outputDir: string, title: string): Promise<DownloadedVideo> {
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
