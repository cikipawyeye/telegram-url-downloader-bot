import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DownloadWorkspace, DownloadWorkspaceStore } from '../../application/ports/download-workspace-store.js';

export class FileSystemDownloadWorkspaceStore implements DownloadWorkspaceStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async prepareRoot(): Promise<void> {
    await fsp.mkdir(this.rootDir, { recursive: true });
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
