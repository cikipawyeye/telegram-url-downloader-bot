/**
 * Magnet / BitTorrent helpers for the aria2-based download path.
 *
 * yt-dlp cannot handle magnet links, so torrents go through the external
 * `aria2c` binary (see downloader.ts for the process wiring). This module
 * holds the pure parts: magnet URI parsing, .torrent (bencode) metadata
 * parsing, and the aria2 console readout progress parser.
 *
 * Why parse the .torrent ourselves instead of `aria2c --show-files`? The
 * metadata phase saves the .torrent file anyway (`--bt-save-metadata`), and
 * parsing it directly gives the exact file list, sizes and info hash in one
 * step -- which is also what `--select-file` indices and the on-disk output
 * layout are derived from.
 *
 * aria2 facts this module relies on (verified against aria2 1.37):
 *  - `--select-file=N` indices are 1-based and follow the `info.files` order.
 *  - multi-file torrents land at `<dir>/<name>/<path...>`, single-file
 *    torrents at `<dir>/<name>`; the resume control file is always
 *    `<dir>/<name>.aria2`.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { VideoDownloadProgress } from './utils.js';

// -- magnet URI parsing ----------------------------------------------------

/** Internal fragment that carries the 1-based `--select-file` index. */
const MAGNET_FILE_FRAGMENT_PATTERN = /#file=(\d+)$/i;
const MAGNET_INFO_HASH_PATTERN = /[?&]xt=urn:btih:([a-z2-7]{32}|[0-9a-f]{40})/i;

export function isMagnetUrl(url: string): boolean {
  return /^magnet:\?/i.test(url.trim());
}

export type MagnetRef = {
  /** The magnet URI without the internal `#file=N` fragment. */
  magnet: string;
  /** 1-based aria2 file index, present on URLs produced by `buildMagnetRef`. */
  fileIndex?: number;
};

/** Split a magnet URL into the plain magnet URI and its optional file index. */
export function parseMagnetRef(url: string): MagnetRef {
  const trimmed = url.trim();
  const match = trimmed.match(MAGNET_FILE_FRAGMENT_PATTERN);

  if (!match) {
    return { magnet: trimmed };
  }

  return {
    magnet: trimmed.slice(0, match.index),
    fileIndex: Number(match[1]),
  };
}

/**
 * Tag one file of a torrent for delivery, e.g. `magnet:?xt=...#file=2`. The
 * fragment is internal bookkeeping (magnet URIs never use fragments): it keeps
 * every video file of a multi-file torrent a separate, addressable link while
 * the batch machinery stays URL-based.
 */
export function buildMagnetRef(magnet: string, fileIndex: number): string {
  return `${parseMagnetRef(magnet).magnet}#file=${fileIndex}`;
}

/**
 * The torrent's info hash in lowercase, or undefined when the magnet carries
 * no usable `xt=urn:btih:` (hex and base32 forms are both accepted). Used as
 * the stable download identity and metadata cache key.
 */
export function extractMagnetInfoHash(url: string): string | undefined {
  const { magnet } = parseMagnetRef(url);
  const match = magnet.match(MAGNET_INFO_HASH_PATTERN);
  return match ? match[1].toLowerCase() : undefined;
}

// -- torrent (bencode) metadata -------------------------------------------

export type TorrentFileEntry = {
  /** 1-based index matching `aria2c --show-files` / `--select-file`. */
  index: number;
  /**
   * Path of the file on disk relative to the aria2 `--dir`, including the
   * torrent name as the first segment (e.g. `['Pack', 'season1', 'ep2.mkv']`).
   */
  pathParts: string[];
  length: number;
};

export type TorrentMetadata = {
  name: string;
  files: TorrentFileEntry[];
  /** Lowercase hex info hash (sha1 of the raw `info` dict). */
  infoHashHex: string;
};

type BencodeDict = Map<string, Decoded>;

type Decoded = {
  value: number | Buffer | Decoded[] | BencodeDict;
  start: number;
  end: number;
};

function decodeBencode(input: Buffer, offset: number): Decoded {
  const marker = input[offset];

  if (marker === undefined) {
    throw new Error('Torrent metadata terpotong.');
  }

  if (marker === 0x69 /* i */) {
    const end = input.indexOf(0x65 /* e */, offset);
    if (end === -1) {
      throw new Error('Torrent metadata tidak valid (integer).');
    }
    const value = Number(input.subarray(offset + 1, end).toString('ascii'));
    if (!Number.isFinite(value)) {
      throw new Error('Torrent metadata tidak valid (integer).');
    }
    return { value, start: offset, end: end + 1 };
  }

  if (marker === 0x6c /* l */) {
    const items: Decoded[] = [];
    let cursor = offset + 1;
    while (input[cursor] !== 0x65 /* e */) {
      const item = decodeBencode(input, cursor);
      items.push(item);
      cursor = item.end;
    }
    return { value: items, start: offset, end: cursor + 1 };
  }

  if (marker === 0x64 /* d */) {
    const dict: BencodeDict = new Map();
    let cursor = offset + 1;
    while (input[cursor] !== 0x65 /* e */) {
      const key = decodeBencode(input, cursor);
      if (!Buffer.isBuffer(key.value)) {
        throw new Error('Torrent metadata tidak valid (key dict).');
      }
      const value = decodeBencode(input, key.end);
      dict.set(key.value.toString('utf8'), value);
      cursor = value.end;
    }
    return { value: dict, start: offset, end: cursor + 1 };
  }

  // Byte string: `<len>:<bytes>`.
  const colon = input.indexOf(0x3a /* : */, offset);
  if (colon === -1) {
    throw new Error('Torrent metadata tidak valid (string).');
  }
  const length = Number(input.subarray(offset, colon).toString('ascii'));
  if (!Number.isInteger(length) || length < 0) {
    throw new Error('Torrent metadata tidak valid (string).');
  }
  const start = colon + 1;
  const end = start + length;
  if (end > input.length) {
    throw new Error('Torrent metadata terpotong.');
  }
  return { value: input.subarray(start, end), start, end };
}

function asDict(decoded: Decoded | undefined): BencodeDict {
  if (decoded === undefined || !(decoded.value instanceof Map)) {
    throw new Error('Torrent metadata tidak valid (bukan dict).');
  }
  return decoded.value;
}

function asNumber(decoded: Decoded | undefined): number {
  if (decoded === undefined || typeof decoded.value !== 'number') {
    throw new Error('Torrent metadata tidak valid (bukan angka).');
  }
  return decoded.value;
}

function asBufferList(decoded: Decoded | undefined): Buffer[] {
  if (decoded === undefined || !Array.isArray(decoded.value)) {
    throw new Error('Torrent metadata tidak valid (bukan list).');
  }
  return decoded.value.map((item) => {
    if (!Buffer.isBuffer(item.value)) {
      throw new Error('Torrent metadata tidak valid (path).');
    }
    return item.value;
  });
}

/**
 * Keep a torrent-provided path segment from escaping the output directory or
 * breaking the path join (separators, control chars, `.`/`..`).
 */
function sanitizePathPart(part: string): string {
  const cleaned = part.replace(/[/\\\x00-\x1f]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

/**
 * Parse a .torrent file into the name, the aria2-style file list (with 1-based
 * indices and on-disk paths) and the info hash. Throws on malformed input.
 */
export function parseTorrentMetadata(torrent: Buffer): TorrentMetadata {
  const root = asDict(decodeBencode(torrent, 0));
  const infoDecoded = root.get('info');

  if (infoDecoded === undefined) {
    throw new Error('Torrent metadata tidak punya info dict.');
  }

  const info = asDict(infoDecoded);

  const infoHashHex = crypto
    .createHash('sha1')
    .update(torrent.subarray(infoDecoded.start, infoDecoded.end))
    .digest('hex');

  const nameEntry = info.get('name');
  if (nameEntry === undefined || !Buffer.isBuffer(nameEntry.value)) {
    throw new Error('Torrent metadata tidak punya nama.');
  }
  const name = sanitizePathPart(nameEntry.value.toString('utf8'));
  const filesEntry = info.get('files');

  if (filesEntry !== undefined) {
    if (!Array.isArray(filesEntry.value)) {
      throw new Error('Torrent metadata tidak valid (files).');
    }

    const files = filesEntry.value.map((fileDecoded, arrayIndex) => {
      const fileDict = asDict(fileDecoded);
      const parts = asBufferList(fileDict.get('path'))
        .map((part) => sanitizePathPart(part.toString('utf8')));
      return {
        index: arrayIndex + 1,
        pathParts: [name, ...parts],
        length: asNumber(fileDict.get('length')),
      };
    });

    return { name, files, infoHashHex };
  }

  // Single-file torrent: the file lands directly at `<dir>/<name>`.
  return {
    name,
    files: [{ index: 1, pathParts: [name], length: asNumber(info.get('length')) }],
    infoHashHex,
  };
}

// -- video file selection --------------------------------------------------

const VIDEO_FILE_EXTENSIONS = new Set([
  '3gp', 'avi', 'divx', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg',
  'mpg', 'mts', 'ts', 'vob', 'webm', 'wmv',
]);

/** True when the file name looks like a video the bot can deliver. */
export function isVideoFileName(fileName: string): boolean {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  return VIDEO_FILE_EXTENSIONS.has(extension);
}

/** The entry to deliver when the magnet names no specific file: the biggest video. */
export function selectLargestVideoFile(files: TorrentFileEntry[]): TorrentFileEntry | undefined {
  let best: TorrentFileEntry | undefined;

  for (const file of files) {
    const fileName = file.pathParts[file.pathParts.length - 1];
    if (!isVideoFileName(fileName)) {
      continue;
    }
    if (best === undefined || file.length > best.length) {
      best = file;
    }
  }

  return best;
}

// -- aria2 console readout -------------------------------------------------

const ARIA2_SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(i?)B?$/i;
const SI_PREFIX_MULTIPLIERS: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000, g: 1_000_000_000, t: 1_000_000_000_000 };
const IEC_PREFIX_MULTIPLIERS: Record<string, number> = { '': 1, k: 1_024, m: 1_048_576, g: 1_073_741_824, t: 1_099_511_627_776 };

function parseAria2Size(text: string): number | undefined {
  const match = text.trim().match(ARIA2_SIZE_PATTERN);
  if (!match) {
    return undefined;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const multipliers = match[3].toLowerCase() === 'i' ? IEC_PREFIX_MULTIPLIERS : SI_PREFIX_MULTIPLIERS;
  const multiplier = multipliers[match[2].toLowerCase()];
  return multiplier === undefined ? undefined : value * multiplier;
}

function parseAria2Eta(text: string): number | undefined {
  const match = text.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return undefined;
  }

  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

// Matches the aria2 console readout, e.g.
//   [#2089b0 400.0KiB/33.2MiB(1%) CN:1 DL:115.7KiB ETA:4m51s]
//   [#83f00b 0B/0B CN:3 SD:0 DL:0B]                (total unknown, no %)
// With `--select-file` the totals cover exactly the selected files.
const ARIA2_READOUT_PATTERN = /\[#\w+\s+([^\s/]+)\/([^\s(]+)(?:\(([\d.]+)%\))?\s+CN:\d+(?:\s+SD:\d+)?\s+DL:([^\s(]+)(?:\s+ETA:([^\s\]]+))?\]/;

export function parseAria2ProgressLine(line: string): VideoDownloadProgress | undefined {
  const match = line.match(ARIA2_READOUT_PATTERN);
  if (!match) {
    return undefined;
  }

  const downloadedBytes = parseAria2Size(match[1]);
  const totalBytes = parseAria2Size(match[2]);
  const reportedPercent = match[3] !== undefined ? Number(match[3]) : undefined;

  const percent = reportedPercent !== undefined && Number.isFinite(reportedPercent)
    ? reportedPercent
    : totalBytes !== undefined && totalBytes > 0 && downloadedBytes !== undefined
      ? (downloadedBytes / totalBytes) * 100
      : undefined;

  return {
    status: 'downloading',
    downloadedBytes,
    totalBytes,
    speedBytesPerSecond: parseAria2Size(match[4]),
    etaSeconds: match[5] !== undefined ? parseAria2Eta(match[5]) : undefined,
    percent,
  };
}

// -- metadata cache --------------------------------------------------------

/**
 * Where fetched .torrent metadata is cached between the expansion phase (list
 * the video files) and the per-file download phase. Override with
 * MAGNET_META_CACHE_DIR, e.g. to keep tests isolated.
 */
export function magnetMetaCacheDir(): string {
  return process.env.MAGNET_META_CACHE_DIR || path.join(os.tmpdir(), 'telegram-video-bot-magnet-meta');
}