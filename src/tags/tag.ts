import { formatBytes, truncateCaption } from '../video/utils.js';

/** Longest tag kept after normalization; longer input is cut at this width. */
export const MAX_TAG_LENGTH = 32;

/** Words that clear the active tag instead of creating one. */
const TAG_CLEAR_WORDS = new Set(['off', '-', 'hapus', 'clear', 'reset']);

/** One row of the per-chat tag list (`/tags`). */
export type TagSummary = {
  tag: string;
  /** How many downloads of this chat carry the tag. */
  total: number;
  /** Newest item that used the tag (epoch seconds), used for ordering. */
  lastUsedAt: number;
};

/** One download shown by `/tags <nama>`. */
export type TaggedItem = {
  url: string;
  title: string | null;
  status: 'pending' | 'done' | 'failed' | 'cancelled';
  fileSizeBytes: number | null;
  finishedAt: number | null;
};

/**
 * Turn user input into the tag stored in the database.
 *
 * Tags are normalized so `#Film`, `film` and `FILM` all mean the same tag:
 * lowercase, every run of punctuation/whitespace becomes `-`, the rest is kept
 * (Unicode letters and digits, `_`, `-`) and the result is capped at
 * MAX_TAG_LENGTH. Input that leaves nothing usable (`"@#$"`, emoji only) is
 * rejected with `undefined` instead of storing an invisible tag.
 */
export function normalizeTag(raw: string): string | undefined {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (normalized.length === 0) {
    return undefined;
  }

  const capped = normalized.slice(0, MAX_TAG_LENGTH).replace(/-+$/g, '');

  // "_" alone survives the punctuation collapse but is not a usable label.
  if (capped.length === 0 || !/[\p{L}\p{N}]/u.test(capped)) {
    return undefined;
  }

  return capped;
}

/** True for `/tag off` (and its aliases), which removes the active tag. */
export function isTagClearCommand(raw: string): boolean {
  return TAG_CLEAR_WORDS.has(raw.trim().toLowerCase().replace(/^#+/, ''));
}

export function buildTagConfirmation(tag: string): string {
  return [
    `Tag "${tag}" aktif untuk unduhan berikutnya.`,
    '',
    'Kirim link video sekarang, atau beberapa link sekaligus dalam satu pesan.',
    `Tag dipakai sekali; ulangi /tag ${tag} untuk unduhan berikutnya.`,
    'Ketik /tag off untuk membatalkan.',
  ].join('\n');
}

export function buildTagCleared(): string {
  return 'Tag aktif dihapus. Unduhan berikutnya tidak akan diberi tag.';
}

/**
 * Caption line shown on the delivered video/screenshots.
 *
 * Telegram ends a hashtag at `-`, so `#film-korea` only links the `film` part.
 * The full normalized tag is kept anyway: it matches the value in `/tags`, and
 * Telegram still makes the first part searchable.
 */
export function buildTagCaptionLine(tag: string): string {
  return `#${tag}`;
}

/** Append the tag line under a video caption (title, part label, ...). */
export function appendTagToCaption(caption: string, tag?: string): string {
  if (tag === undefined) {
    return caption;
  }

  return truncateCaption(`${caption.trimEnd()}\n\n${buildTagCaptionLine(tag)}`);
}

export function buildInvalidTagMessage(raw: string): string {
  return [
    `Tag "${truncateCaption(raw.trim(), 40)}" tidak valid.`,
    '',
    'Gunakan huruf, angka, spasi, "-" atau "_" (maksimal 32 karakter).',
    'Contoh: /tag film, /tag film korea',
  ].join('\n');
}

export function buildTagUsage(): string {
  return [
    'Beri tag untuk unduhan berikutnya:',
    '',
    '/tag <nama>   contoh: /tag film',
    '/tags         lihat daftar tag',
    '/tags <nama>  lihat riwayat unduhan per tag',
    '/tag off      batalkan tag aktif',
  ].join('\n');
}

/** `/tag` without an argument: what is active plus a short overview. */
export function buildTagOverview(activeTag: string | undefined, tags: TagSummary[]): string {
  const lines: string[] = [];

  if (activeTag !== undefined) {
    lines.push(`Tag aktif untuk unduhan berikutnya: "${activeTag}"`, 'Ketik /tag off untuk membatalkan.', '');
  } else {
    lines.push('Belum ada tag aktif.', '');
  }

  lines.push(buildTagUsage());

  if (tags.length > 0) {
    lines.push('', 'Tag di chat ini:', ...tags.slice(0, 10).map(formatTagSummaryLine));
  }

  return truncateCaption(lines.join('\n'), 3500);
}

/** `/tags`: every tag of this chat with its download count. */
export function buildTagList(tags: TagSummary[]): string {
  if (tags.length === 0) {
    return [
      'Belum ada tag di chat ini.',
      '',
      'Buat tag dengan /tag <nama>, mis. /tag film, lalu kirim link videonya.',
    ].join('\n');
  }

  return [
    'Tag di chat ini:',
    '',
    ...tags.map(formatTagSummaryLine),
    '',
    'Lihat riwayat: /tags <nama>, mis. /tags film',
  ].join('\n');
}

/** `/tags <nama>`: the newest downloads that carry the tag. */
export function buildTagHistory(tag: string, items: TaggedItem[]): string {
  if (items.length === 0) {
    return [
      `Belum ada unduhan dengan tag "${tag}".`,
      '',
      `Kirim /tag ${tag} lalu kirimkan link videonya.`,
    ].join('\n');
  }

  const lines = [`Riwayat unduhan dengan tag "${tag}":`, ''];

  for (const [index, item] of items.entries()) {
    const title = truncateCaption(item.title?.trim() || item.url, 80).replace(/\s+/g, ' ');
    const details = [`${index + 1}. ${tagStatusIcon(item.status)} ${title}`];
    const meta: string[] = [];

    if (item.fileSizeBytes !== null && item.fileSizeBytes !== undefined) {
      meta.push(formatBytes(item.fileSizeBytes));
    }

    if (item.finishedAt !== null && item.finishedAt !== undefined) {
      meta.push(formatTagDate(item.finishedAt));
    }

    if (meta.length > 0) {
      details.push(`   ${meta.join(' • ')}`);
    }

    details.push(`   ${truncateCaption(item.url, 120)}`);
    lines.push(details.join('\n'));
  }

  return truncateCaption(lines.join('\n'), 3500);
}

function formatTagSummaryLine(summary: TagSummary): string {
  return `• ${summary.tag} — ${summary.total} unduhan`;
}

function tagStatusIcon(status: TaggedItem['status']): string {
  switch (status) {
    case 'done':
      return '✅';
    case 'failed':
      return '❌';
    case 'cancelled':
      return '⏹';
    default:
      return '⏳';
  }
}

const TAG_DATE_FORMATTER = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTagDate(epochSeconds: number): string {
  return TAG_DATE_FORMATTER.format(new Date(epochSeconds * 1000));
}
