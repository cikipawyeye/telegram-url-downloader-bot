import { summarizeErrorMessage } from './utils.js';

export type DownloadErrorKind = 'permanent' | 'transient' | 'proxy';

export type DownloadErrorClassification = {
  kind: DownloadErrorKind;
  /** False only for errors that can never succeed when retried. */
  retryable: boolean;
  /** Short, user-facing explanation (safe for a Telegram status message). */
  reason: string;
};

/**
 * Final download error with the retry decision attached.
 *
 * The delivery loop uses `kind`/`retryable` to choose the right hint: a
 * permanent error must not tell the user to resend the same dead link, while a
 * proxy error points at `noproxy <link>` instead.
 */
export class DownloadFailure extends Error {
  readonly kind: DownloadErrorKind;
  readonly retryable: boolean;

  constructor(message: string, options: { kind: DownloadErrorKind; retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'DownloadFailure';
    this.kind = options.kind;
    this.retryable = options.retryable ?? options.kind !== 'permanent';

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

// Ordered classification. `yt-dlp`/`gdown`/`aria2c` errors reach us as one
// message (the library folds stderr into it), so message patterns are the only
// portable signal. Unknown errors default to transient: a bounded retry is
// cheaper than giving up on a recoverable network hiccup.
const PROXY_PATTERNS = [
  /ProxyError/i,
  /Socks5Error/i,
  /\bSOCKS(?:5H?)?\b/i,
  /proxy (?:authentication|connect|connection|error|tunnel|refused|failure|failed|required)/i,
  /\bproxy\b.*\b(?:refused|failed|error|unreachable)\b/i,
  /tunnel connection failed/i,
  /\bHTTP(?:\s+Error)?[:\s]+407\b/i,
];

const PERMANENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /private video|video is private|this video is private/i,
    reason: 'Video ini privat.',
  },
  {
    pattern: /video unavailable|video tidak tersedia|removed by (?:the )?uploader|video has been removed/i,
    reason: 'Video tidak tersedia atau sudah dihapus.',
  },
  {
    pattern: /sign in to confirm|confirm your age|age[- ]?restricted|inappropriate for some users/i,
    reason: 'Video butuh login atau verifikasi usia.',
  },
  {
    pattern: /not available in your country|geo[- ]?restrict|blocked (?:it )?in your country|unavailable in your country/i,
    reason: 'Video diblokir di wilayah ini.',
  },
  {
    pattern: /unsupported url|is not a valid url|no video formats found|requested format is not available|unable to extract/i,
    reason: 'URL atau format video tidak didukung.',
  },
  {
    pattern: /\bENOSPC\b|no space left on device|ruang disk tidak cukup/i,
    reason: 'Ruang disk tidak cukup.',
  },
  {
    pattern: /\bEACCES\b|\bEPERM\b|\bEROFS\b|permission denied|read-only file system/i,
    reason: 'Server tidak punya izin menulis file.',
  },
  {
    pattern: /melebihi batas/i,
    reason: 'Ukuran file melebihi batas yang diizinkan.',
  },
  {
    pattern: /torrent tidak berisi file video|tidak ada file video/i,
    reason: 'Torrent tidak berisi file video.',
  },
  {
    pattern: /butuh binary aria2c|binary aria2c.*belum terpasang/i,
    reason: 'aria2c belum terpasang di server.',
  },
  {
    pattern: /link bunk tidak valid format|link file bunk tidak ditemukan|halaman.*tidak ditemukan/i,
    reason: 'Link Bunk tidak valid atau tidak lagi tersedia.',
  },
  {
    pattern: /metadata torrent tidak dapat dibaca|file #\d+ tidak ada di dalam torrent/i,
    reason: 'Isi torrent tidak valid atau tidak lengkap.',
  },
];

const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\btimeout\b|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    reason: 'Koneksi timeout.',
  },
  {
    pattern: /ECONNRESET|connection reset|socket hang up|EPIPE|premature end/i,
    reason: 'Koneksi terputus.',
  },
  {
    pattern: /EAI_AGAIN|ENOTFOUND|getaddrinfo|temporary failure in name resolution/i,
    reason: 'DNS sementara gagal.',
  },
  {
    pattern: /ECONNREFUSED|connection refused/i,
    reason: 'Koneksi ditolak.',
  },
  {
    pattern: /EHOSTUNREACH|ENETUNREACH|network is unreachable|no route to host/i,
    reason: 'Jaringan tidak dapat dijangkau.',
  },
  {
    pattern: /\bHTTP(?:\s+Error)?[:\s]+(?:429|5\d\d)\b|too many requests|rate limit|service unavailable|bad gateway|gateway timeout|internal server error/i,
    reason: 'Server sedang sibuk (HTTP 429/5xx).',
  },
  {
    pattern: /metadata torrent tidak ditemukan|tidak ada peer|download torrent belum lengkap/i,
    reason: 'Torrent belum mendapat peer yang cukup.',
  },
];

export function classifyDownloadError(
  error: unknown,
  options: { proxyActive?: boolean } = {},
): DownloadErrorClassification {
  const text = collectErrorText(error);
  const fallbackReason = summarizeErrorMessage(error);

  if (error instanceof Error && error.name === 'DownloadCancelledError') {
    return { kind: 'transient', retryable: false, reason: fallbackReason };
  }

  // A local WARP/SOCKS proxy can refuse connections for a few seconds while it
  // restarts. That must never be treated as a permanent link failure.
  const proxySpecific = PROXY_PATTERNS.some((pattern) => pattern.test(text));
  const proxyRefused = options.proxyActive === true && /ECONNREFUSED|connection refused/i.test(text);

  if (proxySpecific || proxyRefused) {
    const refused = /ECONNREFUSED|connection refused/i.test(text);
    return {
      kind: 'proxy',
      retryable: true,
      reason: refused
        ? 'Proxy lokal menolak koneksi (connection refused).'
        : 'Koneksi melalui proxy gagal.',
    };
  }

  const httpStatus = text.match(/\bHTTP(?:\s+Error)?[:\s]+([1-5]\d\d)\b/i)?.[1];

  if (httpStatus !== undefined) {
    const status = Number(httpStatus);

    if (status === 401 || status === 403) {
      return {
        kind: 'permanent',
        retryable: false,
        reason: `Akses ditolak (HTTP ${status}). Link mungkin kedaluwarsa atau butuh login.`,
      };
    }

    if (status === 404 || status === 410) {
      return {
        kind: 'permanent',
        retryable: false,
        reason: `Link tidak ditemukan atau sudah kedaluwarsa (HTTP ${status}).`,
      };
    }

    if (status === 451) {
      return {
        kind: 'permanent',
        retryable: false,
        reason: 'Video diblokir di wilayah ini (HTTP 451).',
      };
    }

    if (status === 400) {
      return {
        kind: 'permanent',
        retryable: false,
        reason: 'Permintaan ditolak server (HTTP 400).',
      };
    }

    if (status === 429 || status >= 500) {
      return { kind: 'transient', retryable: true, reason: `Server sedang sibuk (HTTP ${status}).` };
    }
  }

  for (const { pattern, reason } of PERMANENT_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: 'permanent', retryable: false, reason: withDetail(reason, fallbackReason) };
    }
  }

  for (const { pattern, reason } of TRANSIENT_PATTERNS) {
    if (pattern.test(text)) {
      return { kind: 'transient', retryable: true, reason };
    }
  }

  return { kind: 'transient', retryable: true, reason: fallbackReason };
}

/**
 * Keep the original error detail when it is short, so the status still names
 * the real yt-dlp reason ("Video unavailable") while starting with a clear,
 * human-readable explanation.
 */
function withDetail(reason: string, detail: string): string {
  const trimmed = detail.trim();

  if (trimmed === '' || trimmed.length > 160 || reason.toLowerCase().includes(trimmed.toLowerCase())) {
    return reason;
  }

  return `${reason} (${trimmed})`;
}

/**
 * Flatten an error and its `cause`/`code` chain. `formatFetchError` and the
 * yt-dlp wrapper already do this for their own errors, but a generic Node error
 * (e.g. `fetch failed` with an `ECONNREFUSED` cause) only carries the useful
 * detail one level down.
 */
function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  while (current !== undefined && current !== null && parts.length < 8) {
    if (typeof current === 'string') {
      parts.push(current);
      break;
    }

    if (typeof current !== 'object') {
      parts.push(String(current));
      break;
    }

    if (seen.has(current)) {
      break;
    }
    seen.add(current);

    const entry = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof entry.message === 'string') {
      parts.push(entry.message);
    }
    if (typeof entry.code === 'string') {
      parts.push(entry.code);
    }

    current = entry.cause;
  }

  return parts.join(' ');
}
