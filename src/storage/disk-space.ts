import { statfs } from 'node:fs/promises';

export class InsufficientDiskSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientDiskSpaceError';
  }
}

export type FreeBytesReader = (dir: string) => Promise<number | undefined>;

/**
 * Free bytes available to the service account (not the total filesystem size).
 * `statfs` is not supported everywhere, so a failed probe is reported as
 * "unknown" and callers keep working instead of blocking every download.
 */
export const readFreeDiskBytes: FreeBytesReader = async (dir: string) => {
  try {
    const stats = await statfs(dir);
    const available = Number(stats.bavail) * Number(stats.bsize);

    return Number.isFinite(available) && available >= 0 ? available : undefined;
  } catch (error) {
    console.error(`Failed to read free disk space for ${dir}:`, error);
    return undefined;
  }
};

export type DiskSpaceGuardOptions = {
  dir: string;
  /** Space that must stay free after every active reservation is accounted for. */
  minFreeBytes: number;
  /** Assumed peak size of one running download (a 4 GB+ video plus its split copy). */
  reserveBytes: number;
  readFreeBytes?: FreeBytesReader;
};

/**
 * Admission control for downloads, sized for large (4 GB+) videos.
 *
 * A single large job temporarily needs the download *and* the split (or
 * converted) copy written next to it, so a download is only admitted while
 * `free - activeReservations >= minFreeBytes + reserveBytes`. The reservation
 * is released as soon as that download stops, whatever its outcome, and the
 * real bytes it wrote are then part of the free-space reading again.
 */
export class DiskSpaceGuard {
  private readonly dir: string;
  private readonly minFreeBytes: number;
  private readonly reserveBytes: number;
  private readonly readFreeBytes: FreeBytesReader;
  private reservedBytes = 0;

  constructor(options: DiskSpaceGuardOptions) {
    this.dir = options.dir;
    this.minFreeBytes = Math.max(0, options.minFreeBytes);
    this.reserveBytes = Math.max(0, options.reserveBytes);
    this.readFreeBytes = options.readFreeBytes ?? readFreeDiskBytes;
  }

  /** Bytes currently reserved by running downloads. */
  get reserved(): number {
    return this.reservedBytes;
  }

  /**
   * Reserve room for one download and return the matching release function.
   * Throws `InsufficientDiskSpaceError` when the reservation would eat into the
   * safety margin, so the caller can report it instead of filling the disk.
   */
  async acquire(reserveBytes = this.reserveBytes): Promise<() => void> {
    const freeBytes = await this.readFreeBytes(this.dir);

    if (freeBytes === undefined) {
      // Unsupported filesystem / unreadable path: never block the download.
      return () => undefined;
    }

    const requiredBytes = this.minFreeBytes + this.reservedBytes + reserveBytes;

    if (freeBytes < requiredBytes) {
      throw new InsufficientDiskSpaceError(
        [
          'Ruang disk tidak cukup untuk memulai unduhan.',
          `Tersedia ${formatGigabytes(freeBytes)}, dibutuhkan minimal ${formatGigabytes(requiredBytes)}`,
          `(${formatGigabytes(this.minFreeBytes)} cadangan + ${formatGigabytes(this.reservedBytes + reserveBytes)} untuk unduhan).`,
          'Hapus file sementara atau tambah kapasitas disk, lalu kirim ulang link ini.',
        ].join(' '),
      );
    }

    this.reservedBytes += reserveBytes;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.reservedBytes = Math.max(0, this.reservedBytes - reserveBytes);
    };
  }

  /**
   * Throw when writing `extraBytes` (a split or converted copy of the video)
   * would eat into the safety margin. `context` prefixes the user-facing reason.
   */
  async assertRoomFor(extraBytes: number, context: string): Promise<void> {
    const freeBytes = await this.readFreeBytes(this.dir);

    if (freeBytes === undefined) {
      return;
    }

    const requiredBytes = this.minFreeBytes + extraBytes;

    if (freeBytes >= requiredBytes) {
      return;
    }

    throw new InsufficientDiskSpaceError(
      [
        `${context}: tersedia ${formatGigabytes(freeBytes)},`,
        `dibutuhkan minimal ${formatGigabytes(requiredBytes)}`,
        `(${formatGigabytes(extraBytes)} untuk salinan + ${formatGigabytes(this.minFreeBytes)} cadangan).`,
        'Hapus file sementara atau tambah kapasitas disk, lalu kirim ulang link ini.',
      ].join(' '),
    );
  }
}

function formatGigabytes(bytes: number): string {
  const gigabytes = bytes / (1024 ** 3);

  return `${gigabytes.toFixed(gigabytes >= 10 ? 0 : 1)} GB`;
}
