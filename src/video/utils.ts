import path from 'node:path';

export type DownloadedVideo = {
  filePath: string;
  fileSize: number;
  title: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

export type VideoDownloadProgress = {
  status: 'downloading' | 'finished';
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  percent?: number;
};

export type VideoScreenshot = {
  filePath: string;
  fileName: string;
};

export type VideoThumbnail = {
  filePath: string;
  fileName: string;
};

type ScreenshotPlanItem = {
  fileName: string;
  captureSeconds: number;
};

export function extractUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s]+/gi)]
    .map((match) => match[0].replace(/[),.!?;:]+$/g, ''))
    .filter((url, index, urls) => urls.indexOf(url) === index);
}

export function buildDeliveryFileName(filePath: string, title: string): string {
  const extension = path.extname(filePath);
  const fallbackBaseName = path.basename(filePath, extension);
  const preferredBaseName = title.trim() || fallbackBaseName;
  const normalizedBaseName = sanitizeFileName(preferredBaseName)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const safeFallbackBaseName = sanitizeFileName(fallbackBaseName).trim() || 'video';
  const safeBaseName = truncateFileNameBase(normalizedBaseName || safeFallbackBaseName);

  return `${safeBaseName}${extension}`;
}

export function buildDeliveryPartFileName(filePath: string, title: string, index: number, total: number): string {
  const deliveryFileName = buildDeliveryFileName(filePath, title);
  const extension = path.extname(deliveryFileName);
  const baseName = path.basename(deliveryFileName, extension);
  const partLabel = `part-${String(index).padStart(String(total).length, '0')}-of-${total}`;

  return `${baseName}.${partLabel}${extension}`;
}

export function buildPartCaption(title: string, index: number, total: number): string {
  if (total <= 1) {
    return truncateCaption(title);
  }

  return truncateCaption(`${title}\nPart ${index}/${total}`);
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

export function buildScreenshotPlan(durationSeconds: number, screenshotCount: number): ScreenshotPlanItem[] {
  const normalizedDurationSeconds = Math.max(durationSeconds, 1);
  const maxCaptureSeconds = Math.max(0, normalizedDurationSeconds - Math.min(1, normalizedDurationSeconds / 20));

  return Array.from({ length: screenshotCount }, (_unused, index) => {
    const displaySeconds = normalizedDurationSeconds * ((index + 1) / screenshotCount);
    const captureSeconds = Math.min(displaySeconds, maxCaptureSeconds);

    return {
      fileName: `screenshot-${String(index + 1).padStart(2, '0')}.jpg`,
      captureSeconds,
    };
  });
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

function truncateFileNameBase(fileName: string, maxLength = 120): string {
  if (fileName.length <= maxLength) {
    return fileName;
  }

  return fileName.slice(0, maxLength).trimEnd();
}
