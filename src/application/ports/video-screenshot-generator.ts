export type GeneratedVideoScreenshot = {
  filePath: string;
  fileName: string;
  caption: string;
};

export type GenerateVideoScreenshotsRequest = {
  videoPath: string;
  outputDir: string;
  durationSeconds?: number;
  count: number;
};

export interface VideoScreenshotGenerator {
  generate(request: GenerateVideoScreenshotsRequest): Promise<GeneratedVideoScreenshot[]>;
}
