import express, { type Express } from 'express';
import fsp from 'node:fs/promises';

export function createHttpApp(downloadDir: string): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', async (_req, res) => {
    let freeSpaceBytes: number | null = null;

    try {
      const stats = await fsp.statfs(downloadDir);
      freeSpaceBytes = stats.bavail * stats.bsize;
    } catch (error) {
      console.error('Failed to read filesystem stats for /health:', error);
    }

    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      downloadDir,
      freeSpaceBytes,
    });
  });

  return app;
}
