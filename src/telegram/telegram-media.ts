import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { DownloadCancelledError, formatFetchError } from '../video/downloader.js';
import { formatBytes, type VideoDownloadProgress } from '../video/utils.js';

/** File Bot API standar hanya bisa diunduh sampai 20 MB. */
const STANDARD_API_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
const DEFAULT_API_ROOT = 'https://api.telegram.org';
const ERROR_BODY_LIMIT = 300;

export type TelegramVideoSource = {
  fileId: string;
  fileName?: string;
  fileSize?: number;
  durationSeconds?: number;
};

export type DownloadedTelegramMedia = {
  filePath: string;
  fileName: string;
  fileSize: number;
};

/**
 * Picks the video out of a message. The bot sends videos with `sendVideo`, but
 * a video can also be delivered as a document, so both are accepted.
 */
export function videoSourceFromMessage(message: Message): TelegramVideoSource | undefined {
  const video = message.video;

  if (video) {
    return {
      fileId: video.file_id,
      fileName: video.file_name,
      fileSize: video.file_size,
      durationSeconds: video.duration,
    };
  }

  const document = message.document;

  if (document && document.mime_type?.startsWith('video/')) {
    return {
      fileId: document.file_id,
      fileName: document.file_name,
      fileSize: document.file_size,
    };
  }

  return undefined;
}
/**
 * Fetches a video that already lives on Telegram back onto this machine.
 *
 * With a local Bot API server (`TELEGRAM_API_ROOT`) `getFile` returns the path
 * of the file on the server, so it is copied straight from disk. With the
 * standard Bot API — or when that path is not reachable from this process — the
 * file is streamed over HTTP from the configured API root instead.
 */
export class TelegramMediaDownloader {
  private readonly api: Api;
  private readonly botToken: string;
  private readonly apiRoot?: string;
  private readonly downloadTimeoutMs: number;

  constructor(options: { api: Api; botToken: string; apiRoot?: string; downloadTimeoutMs: number }) {
    this.api = options.api;
    this.botToken = options.botToken;
    this.apiRoot = options.apiRoot;
    this.downloadTimeoutMs = options.downloadTimeoutMs;
  }

  /** True while the standard Bot API (20 MB download limit) is in use. */
  get usesStandardApi(): boolean {
    return this.apiRoot === undefined;
  }

  async download(
    media: TelegramVideoSource,
    options: {
      dirPath: string;
      signal?: AbortSignal;
      onProgress?: (progress: VideoDownloadProgress) => void;
    },
  ): Promise<DownloadedTelegramMedia> {
    const file = await this.api.getFile(media.fileId);
    const remotePath = file.file_path;

    if (!remotePath) {
      throw new Error('Telegram tidak mengembalikan lokasi file video.');
    }

    const fileName = media.fileName?.trim() || path.basename(remotePath) || 'video.mp4';
    const extension = path.extname(fileName) || path.extname(remotePath) || '.mp4';
    const filePath = path.join(options.dirPath, `telegram-video${extension}`);

    if (path.isAbsolute(remotePath)) {
      try {
        await fsp.copyFile(remotePath, filePath);
        const stat = await fsp.stat(filePath);
        return { filePath, fileName, fileSize: stat.size };
      } catch (error) {
        // The local Bot API server may keep its files on another machine or
        // volume; fall back to the HTTP download below.
        console.error('Failed to copy the local Bot API file, falling back to HTTP download:', error);
      }
    }

    const fileSize = media.fileSize ?? file.file_size;
    await this.downloadOverHttp({
      remotePath,
      filePath,
      totalBytes: fileSize !== undefined && fileSize > 0 ? fileSize : undefined,
      signal: options.signal,
      onProgress: options.onProgress,
    });

    const stat = await fsp.stat(filePath);
    return { filePath, fileName, fileSize: stat.size };
  }


  private async downloadOverHttp(options: {
    remotePath: string;
    filePath: string;
    totalBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: VideoDownloadProgress) => void;
  }): Promise<void> {
    if (
      this.usesStandardApi &&
      options.totalBytes !== undefined &&
      options.totalBytes > STANDARD_API_FILE_LIMIT_BYTES
    ) {
      throw new Error(
        `Video ini ${formatBytes(options.totalBytes)}, sedangkan Bot API standar hanya bisa mengunduh file sampai ` +
          `${formatBytes(STANDARD_API_FILE_LIMIT_BYTES)}. Set TELEGRAM_API_ROOT ke local Bot API server untuk video sebesar ini.`,
      );
    }

    const root = (this.apiRoot ?? DEFAULT_API_ROOT).replace(/\/+$/, '');
    const url = `${root}/file/bot${this.botToken}/${options.remotePath}`;
    const timeoutSignal = AbortSignal.timeout(this.downloadTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let downloadedBytes = 0;

    let response: Response;
    try {
      response = await fetch(url, { signal });
    } catch (error) {
      throw this.mapDownloadError(error, options.signal, timeoutSignal);
    }

    if (!response.ok || response.body === null) {
      const body = await response.text().catch(() => '');
      const detail = body.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_LIMIT);

      throw new Error(`Telegram menolak unduhan file (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`);
    }

    const totalBytes = options.totalBytes;

    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            downloadedBytes += chunk.length;
            options.onProgress?.({ status: 'downloading', downloadedBytes, totalBytes });
            yield chunk;
          }
        },
        createWriteStream(options.filePath),
        { signal },
      );
    } catch (error) {
      throw this.mapDownloadError(error, options.signal, timeoutSignal);
    }

    options.onProgress?.({ status: 'finished', downloadedBytes, totalBytes });
  }

  private mapDownloadError(error: unknown, signal: AbortSignal | undefined, timeoutSignal: AbortSignal): Error {
    if (signal?.aborted) {
      return new DownloadCancelledError();
    }

    if (timeoutSignal.aborted) {
      return new Error(`Unduhan dari Telegram timeout setelah ${Math.round(this.downloadTimeoutMs / 1000)} detik.`);
    }

    return new Error(`Gagal mengunduh file dari Telegram. ${formatFetchError(error)}`);
  }
}

