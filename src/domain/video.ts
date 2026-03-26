import path from 'node:path';

export type DownloadedVideo = {
  filePath: string;
  fileSize: number;
  title: string;
};

export type VideoDownloadProgress = {
  status: 'downloading' | 'finished';
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  percent?: number;
};

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

export function buildDeliveryFileName(filePath: string): string {
  return sanitizeFileName(path.basename(filePath));
}

export function truncateCaption(title: string, maxLength = 900): string {
  if (title.length <= maxLength) {
    return title;
  }

  return `${title.slice(0, maxLength - 1)}…`;
}

export function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export function formatDownloadProgress(progress: VideoDownloadProgress): string {
  const lines = ['Sedang mendownload video...'];
  const progressParts: string[] = [];
  const detailParts: string[] = [];

  if (progress.percent !== undefined) {
    progressParts.push(`${Math.min(100, progress.percent).toFixed(progress.percent >= 10 ? 0 : 1)}%`);
  }

  if (progress.downloadedBytes !== undefined) {
    if (progress.totalBytes !== undefined) {
      progressParts.push(`${formatBytes(progress.downloadedBytes)} / ${formatBytes(progress.totalBytes)}`);
    } else {
      progressParts.push(formatBytes(progress.downloadedBytes));
    }
  }

  if (progress.speedBytesPerSecond !== undefined && progress.speedBytesPerSecond > 0) {
    detailParts.push(`${formatBytes(progress.speedBytesPerSecond)}/s`);
  }

  if (progress.etaSeconds !== undefined && progress.etaSeconds >= 0) {
    detailParts.push(`ETA ${formatDuration(progress.etaSeconds)}`);
  }

  if (progressParts.length > 0) {
    lines.push(progressParts.join(' • '));
  }

  if (detailParts.length > 0) {
    lines.push(detailParts.join(' • '));
  }

  return lines.join('\n');
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}j ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}d`;
  }

  return `${remainingSeconds}d`;
}
