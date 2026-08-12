import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type DownloadWorkspace = {
  dirPath: string;
};

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly orphanThresholdMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(rootDir: string, orphanThresholdMs = 24 * 60 * 60 * 1000) {
    this.rootDir = rootDir;
    this.orphanThresholdMs = orphanThresholdMs;
  }

  async prepareRoot(): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true });
    await this.sweepOrphans();
  }

  async getFreeSpaceBytes(dirPath: string = this.rootDir): Promise<number> {
    const stats = await fsp.statfs(dirPath);
    return stats.bavail * stats.bsize;
  }

  async sweepOrphans(): Promise<void> {
    let entries: string[] = [];

    try {
      entries = await fsp.readdir(this.rootDir);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }

      console.error('Failed to read download dir for orphan sweep:', error);
      return;
    }

    const now = Date.now();

    for (const entry of entries) {
      const dirPath = path.join(this.rootDir, entry);

      try {
        const stat = await fsp.stat(dirPath);

        if (!stat.isDirectory()) {
          continue;
        }

        if (now - stat.mtimeMs <= this.orphanThresholdMs) {
          continue;
        }

        await fsp.rm(dirPath, { recursive: true, force: true });
        console.log(`Removed orphan download dir: ${dirPath}`);
      } catch (error) {
        console.error(`Failed to sweep orphan dir ${dirPath}:`, error);
      }
    }
  }

  startAutoSweep(intervalMs = 6 * 60 * 60 * 1000): void {
    if (this.sweepTimer) {
      return;
    }

    this.sweepTimer = setInterval(() => {
      void this.sweepOrphans();
    }, intervalMs);

    this.sweepTimer.unref();
  }

  stopAutoSweep(): void {
    if (!this.sweepTimer) {
      return;
    }

    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  async create(userId: string): Promise<DownloadWorkspace> {
    const jobId = `${Date.now()}-${userId}-${crypto.randomUUID()}`;
    const dirPath = path.join(this.rootDir, jobId);

    await fsp.mkdir(dirPath, { recursive: true });

    return { dirPath };
  }

  async remove(workspace: DownloadWorkspace): Promise<void> {
    try {
      await fsp.rm(workspace.dirPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`Failed to remove temp dir ${workspace.dirPath}:`, error);
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
