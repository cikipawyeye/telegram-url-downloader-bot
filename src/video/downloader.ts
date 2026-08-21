import { spawn } from 'node:child_process';
import * as dns from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import fsp from 'node:fs/promises';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { type DownloadFinishResult, type VideoProgress as YtDlpVideoProgress, YtDlp } from 'ytdlp-nodejs';
import { type DownloadedVideo, type VideoDownloadProgress } from './utils.js';

// Sign endpoint that issues a time-limited token for a Bunkr media path.
const BUNKR_SIGN_ENDPOINT = 'https://glb-apisign.cdn.cr/sign';
const BUNKR_REFERER = 'https://dl.bunkr.cr/';
// The JSON/API calls are small, so fail fast instead of relying on the
// (possibly much larger) download timeout.
const BUNKR_API_TIMEOUT_MS = 30_000;
const BUNKR_ERROR_BODY_LIMIT = 64 * 1024;

// Bunkr/Cloudflare can reject requests that look like a bot. Use the exact
// browser header set captured from the official site (sec-ch-*, user-agent, etc.)
const BUNKR_BROWSER_HEADERS: Record<string, string> = {
  'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9,id;q=0.8',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  referer: BUNKR_REFERER,
};

// The default fetch (undici) sometimes picks an unroutable IPv6 address and
// times out (UND_ERR_CONNECT_TIMEOUT), while IPv4 works fine. So Bunkr requests
// go through node:https with an IPv4-only resolver (SNI/hostname stays intact).
// The IPv4-only lookup resolves A records through node:dns and hands the socket
// family 4, avoiding the flaky IPv6 connection entirely.
function bunkrIpv4Lookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  void dns.lookup(hostname, { family: 4, all: true }).then(
    (addresses) => {
      const ipv4 = addresses.filter((address) => address.family === 4);
      if (options.all) {
        callback(null, ipv4);
      } else {
        callback(null, ipv4[0]?.address ?? hostname, 4);
      }
    },
    (error: Error) => callback(error, '', 4),
  );
}

const BUNKR_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  lookup: bunkrIpv4Lookup,
  maxSockets: 16,
});

// Prefer a progressive MP4, but fall back to separate streams when YouTube
// does not provide a suitable single file.
const VIDEO_FORMAT = 'best[ext=mp4][vcodec^=avc1][acodec^=mp4a]/bestvideo+bestaudio/best';
const METADATA_PROBE_TIMEOUT_MS = 30_000;

export class DownloadCancelledError extends Error {
  constructor() {
    super('Unduhan dibatalkan oleh pengguna.');
    this.name = 'DownloadCancelledError';
  }
}

export type DownloadVideoOptions = {
  url: string;
  outputDir: string;
  signal?: AbortSignal;
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
  private readonly proxy?: string;
  private readonly ytdlp: YtDlp;

  constructor(options: { downloadTimeoutMs: number; proxy?: string; ytdlp: YtDlp }) {
    this.downloadTimeoutMs = options.downloadTimeoutMs;
    this.proxy = options.proxy;
    this.ytdlp = options.ytdlp;
  }

  async download(options: DownloadVideoOptions): Promise<DownloadedVideo> {
    if (isBunkrFileUrl(options.url)) {
      return await this.downloadFromBunk(options);
    }

    const { onProgress, outputDir, signal, url } = options;
    const outputTemplate = path.join(outputDir, 'download.%(ext)s');
    const download = this.ytdlp.download(url, {
      format: VIDEO_FORMAT,
      mergeOutputFormat: 'mp4',
      noPlaylist: true,
      output: outputTemplate,
      progressDelta: 2,
      proxy: this.proxy,
    });

    if (onProgress) {
      download.on('progress', (progress) => {
        onProgress(mapProgress(progress));
      });
    }

    const result = await this.runWithTimeout(download, signal);
    return await this.resolveDownloadedVideo(result, outputDir);
  }

  private async downloadFromBunk({ onProgress, outputDir, signal, url }: DownloadVideoOptions): Promise<DownloadedVideo> {
    const fileId = extractBunkrFileId(url);
    if (fileId === undefined) {
      throw new Error('Link Bunk tidak valid format. Hanya URL /file/<id> dukung.');
    }

    const origin = new URL(url).origin;
    const detail = await this.fetchBunkDetail(fileId, origin);

    const extension = path.extname(detail.original) || '.mp4';
    const outputPath = path.join(outputDir, `bunk-video${extension}`);

    const fileSize = await this.downloadBunkFile({
      url: detail.downloadUrl,
      outputPath,
      signal,
      onProgress,
    });

    const metadata = await this.resolveVideoMetadata(outputPath, {});

    return {
      filePath: outputPath,
      fileSize,
      title: detail.original,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
    };
  }

  private async fetchBunkDetail(fileId: string, origin: string): Promise<{ downloadUrl: string; original: string }> {
    const detail = await this.fetchBunkJson(`${origin}/api/_001_v2`, {
      method: 'POST',
      json: { id: fileId },
    });

    const mediaBase = readJsonString(detail, 'mediafiles');
    const original = readJsonString(detail, 'original');
    const mediaPath = readJsonString(detail, 'path');

    if (!mediaBase || !original || !mediaPath) {
      throw new Error('Bunk detail respons tidak komplet.');
    }

    const sign = await this.fetchBunkSignature(mediaPath);
    const downloadUrl = `${mediaBase}${mediaPath}?n=${encodeURIComponent(original)}&token=${encodeURIComponent(sign.token)}&ex=${String(sign.ex)}`;

    return { downloadUrl, original };
  }

  private async fetchBunkSignature(mediaPath: string): Promise<{ ex: string; token: string }> {
    const signUrl = `${BUNKR_SIGN_ENDPOINT}?path=${encodeURIComponent(mediaPath)}`;
    const data = await this.fetchBunkJson(signUrl, { method: 'GET' });

    const token = readJsonString(data, 'token');
    const ex = readJsonRaw(data, 'ex');

    if (!token || ex === undefined) {
      throw new Error('Bunk sign responsif tidak komplet.');
    }

    return { ex: String(ex), token };
  }

  private async fetchBunkJson(
    url: string,
    options: { method: 'GET' | 'POST'; json?: unknown },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      ...BUNKR_BROWSER_HEADERS,
      accept: 'application/json, text/plain, */*',
    };
    let body: string | undefined;

    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const { status, text } = await this.requestBunkText(url, options.method, headers, body, BUNKR_API_TIMEOUT_MS);

    if (status < 200 || status >= 300) {
      throw new Error(`Bunk API responde HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    const parsed = parseJsonRecord(text);
    if (parsed === undefined) {
      throw new Error(`Bunk API respons tidak valid JSON: ${text.slice(0, 200)}`);
    }
    return parsed;
  }

  private async requestBunkText(
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.bunkRawRequest(new URL(url), method, headers, body, controller.signal);
      const text = await readResponseBody(response).catch(() => '');
      return { status: response.statusCode ?? 0, text };
    } catch (error) {
      throw this.mapBunkHttpError(error, timedOut, url, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private async bunkRawRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    return await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request(
        {
          agent: BUNKR_HTTPS_AGENT,
          headers,
          hostname: url.hostname,
          method,
          path: `${url.pathname}${url.search}`,
          port: url.port || 443,
          servername: url.hostname,
          signal,
        },
        (response) => resolve(response),
      );
      request.on('error', reject);
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }

  private async downloadBunkFile(options: {
    url: string;
    outputPath: string;
    signal?: AbortSignal;
    onProgress?: (progress: VideoDownloadProgress) => void;
  }): Promise<number> {
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) {
        throw new DownloadCancelledError();
      }
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.downloadTimeoutMs);

    try {
      return await this.streamBunkToFile({
        url: options.url,
        outputPath: options.outputPath,
        signal: controller.signal,
        onProgress: options.onProgress,
        isTimedOut: () => timedOut,
      });
    } finally {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async streamBunkToFile(options: {
    url: string;
    outputPath: string;
    signal: AbortSignal;
    onProgress?: (progress: VideoDownloadProgress) => void;
    isTimedOut: () => boolean;
  }): Promise<number> {
    let response: IncomingMessage;
    try {
      response = await this.bunkRawRequest(
        new URL(options.url),
        'GET',
        { ...BUNKR_BROWSER_HEADERS, accept: 'video/*' },
        undefined,
        options.signal,
      );
    } catch (error) {
      throw this.mapBunkHttpError(error, options.isTimedOut(), options.url, this.downloadTimeoutMs);
    }

    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      const sample = await readResponseBody(response).catch(() => '');
      throw new Error(`Bunk unduh responde HTTP ${status}${sample ? `: ${sample.slice(0, 200)}` : ''}`);
    }

    const totalBytes = parseContentLength(String(response.headers['content-length'] ?? ''));
    const started = Date.now();
    let downloadedBytes = 0;
    const file = await fsp.open(options.outputPath, 'w');

    const emitProgress = () => {
      if (options.onProgress === undefined) {
        return;
      }

      const elapsedSeconds = Math.max(1, (Date.now() - started) / 1000);
      const hasTotal = totalBytes !== undefined && totalBytes > 0;
      options.onProgress({
        status: 'downloading',
        downloadedBytes,
        totalBytes,
        speedBytesPerSecond: downloadedBytes > 0 ? downloadedBytes / elapsedSeconds : undefined,
        percent: hasTotal ? (downloadedBytes / totalBytes) * 100 : undefined,
      });
    };

    try {
      for await (const chunk of response) {
        await file.writeFile(chunk);
        downloadedBytes += chunk.length;
        emitProgress();
      }
    } catch (error) {
      throw this.mapBunkHttpError(error, options.isTimedOut(), options.url, this.downloadTimeoutMs);
    } finally {
      await file.close().catch(() => undefined);
      response.destroy();
    }

    const finalSize = await fsp.stat(options.outputPath).then((entry) => entry.size).catch(() => downloadedBytes);
    options.onProgress?.({ status: 'finished', downloadedBytes: finalSize });
    return finalSize;
  }

  private mapBunkHttpError(error: unknown, timedOut: boolean, url: string, timeoutMs: number): Error {
    if (timedOut) {
      return new Error(`Bunk timeout para ${describeBunkUrl(url)} setelah ${Math.round(timeoutMs / 1000)} detik.`);
    }
    if (isAbortError(error)) {
      return new DownloadCancelledError();
    }
    return new Error(`Bunk gagal para ${describeBunkUrl(url)}. ${formatFetchError(error)}`);
  }

  private async runWithTimeout(
    download: ReturnType<YtDlp['download']>,
    signal?: AbortSignal,
  ): Promise<DownloadFinishResult> {
    return await new Promise<DownloadFinishResult>((resolve, reject) => {
      let settled = false;

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
        download.kill('SIGKILL');
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
        download.kill('SIGKILL');
        reject(new Error(`Proses download timeout setelah ${Math.round(this.downloadTimeoutMs / 1000)} detik.`));
      }, this.downloadTimeoutMs);

      void download.run().then(
        (result) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
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

function isBunkrFileUrl(url: string): boolean {
  return /^https?:\/\/(?:[a-z0-9-]+\.)*bunkr\.[a-z]{2,}\/file\//i.test(url);
}

function extractBunkrFileId(url: string): string | undefined {
  const match = url.match(/^https?:\/\/(?:[a-z0-9-]+\.)*bunkr\.[a-z]{2,}\/file\/([^\/?#]+)/i);
  return match ? match[1] : undefined;
}

function readJsonString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function readJsonRaw(source: Record<string, unknown>, key: string): unknown {
  return source[key];
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function readResponseBody(response: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of response) {
    text += chunk;
    if (text.length >= BUNKR_ERROR_BODY_LIMIT) {
      break;
    }
  }
  return text;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ERR_ABORTED';
}

function formatFetchError(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error);
  }

  const parts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  // undici's fetch wraps the real failure in a chain: top-level TypeError
  // ("fetch failed") -> cause -> ... -> the OS error (e.g. ENOTFOUND). Walk
  // the chain and keep the meaningful messages, skipping the generic ones.
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);

    const entry = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof entry.code === 'string' ? entry.code : undefined;
    const rawMessage = typeof entry.message === 'string' ? entry.message : undefined;
    const message = rawMessage && rawMessage !== 'fetch failed' ? rawMessage : undefined;

    const detail = code ? (message ? `${code}: ${message}` : code) : message;
    if (detail && !parts.includes(detail)) {
      parts.push(detail);
    }

    current = entry.cause;
  }

  return parts.length > 0 ? parts.join(' → ') : formatError(error);
}

function describeBunkUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
