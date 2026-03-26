import express, { type Express } from 'express';

type CreateHttpAppDependencies = {
  downloadDir: string;
};

export function createHttpApp(dependencies: CreateHttpAppDependencies): Express {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      downloadDir: dependencies.downloadDir,
    });
  });

  return app;
}
