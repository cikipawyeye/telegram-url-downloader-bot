import type { DownloadedVideo, VideoDownloadProgress } from '../../domain/video.js';

export type DownloadVideoRequest = {
  url: string;
  outputDir: string;
  onProgress?: (progress: VideoDownloadProgress) => void;
};

export interface VideoDownloader {
  download(request: DownloadVideoRequest): Promise<DownloadedVideo>;
}
