import express, { type Express } from 'express';

export function createHttpApp(downloadDir: string): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      downloadDir,
    });
  });

  return app;
}
