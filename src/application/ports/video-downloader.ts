import type { DownloadedVideo } from '../../domain/video.js';

export interface VideoDownloader {
  download(url: string, outputDir: string): Promise<DownloadedVideo>;
}
