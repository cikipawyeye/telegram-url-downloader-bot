import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DownloadCancelledError } from '../video/downloader.js';

export type AudioProbe = {
  hasAudioStream: boolean;
  durationSeconds?: number;
};

export type ExtractedAudio = {
  filePath: string;
  fileSize: number;
  durationSeconds?: number;
};

const AUDIO_OUTPUT_FILE_NAME = 'audio.mp3';

/**
 * Extracts the audio track of a video into an MP3 that Telegram can stream as
 * audio (VBR ~190 kbps, ID3v2.3 tags).
 */
export class AudioExtractor {
  private readonly commandTimeoutMs: number;

  constructor(options: { commandTimeoutMs: number }) {
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  /**
   * Reads whether the file has an audio track plus its duration, so a video
   * without audio fails with a clear message instead of ffmpeg's
   * "Stream map '0:a:0' matches no streams".
   */
  async probe(videoPath: string): Promise<AudioProbe> {
    let output: string;

    try {
      output = await this.runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=codec_type:format=duration',
        '-of',
        'json',
        videoPath,
      ]);
    } catch (error) {
      throw new Error(`Gagal membaca file video. ${formatError(error)}`);
    }

    return parseProbe(output);
  }

  async extract(options: {
    videoPath: string;
    outputDir: string;
    /** Source duration, used to report extraction progress. */
    durationSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (percent: number) => void;
  }): Promise<ExtractedAudio> {
    const outputFilePath = path.join(options.outputDir, AUDIO_OUTPUT_FILE_NAME);
    const progress = createProgressReader(options.durationSeconds, options.onProgress);

    await this.runCommand(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        // Machine-readable progress on stdout, so stderr stays reserved for the
        // error message that is shown to the user.
        '-nostats',
        '-progress',
        'pipe:1',
        '-i',
        options.videoPath,
        // Audio only: drop the video track and keep the first audio stream.
        '-vn',
        '-map',
        '0:a:0',
        '-c:a',
        'libmp3lame',
        '-q:a',
        '2',
        '-id3v2_version',
        '3',
        outputFilePath,
      ],
      { signal: options.signal, onStdout: progress },
    );

    const stat = await fsp.stat(outputFilePath);
    const extractedProbe = await this.probe(outputFilePath);

    return {
      filePath: outputFilePath,
      fileSize: stat.size,
      durationSeconds: extractedProbe.durationSeconds ?? options.durationSeconds,
    };
  }

  private runCommand(
    command: string,
    args: string[],
    options: { signal?: AbortSignal; onStdout?: (chunk: string) => void } = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(new DownloadCancelledError());
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }

        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        child.kill('SIGKILL');
        reject(new Error(`${command} timeout setelah ${Math.round(this.commandTimeoutMs / 1000)} detik.`));
      }, this.commandTimeoutMs);

      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout += text;
        options.onStdout?.(text);
      });

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (code === 0) {
          resolve(stdout);
          return;
        }

        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
        reject(new Error(output || `${command} exited with code ${code}`));
      });
    });
  }
}

function parseProbe(output: string): AudioProbe {
  try {
    const parsed = JSON.parse(output) as {
      streams?: Array<{ codec_type?: string }>;
      format?: { duration?: string };
    };
    const duration = Number(parsed.format?.duration);

    return {
      hasAudioStream: (parsed.streams?.length ?? 0) > 0,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    };
  } catch (error) {
    console.error('Failed to parse audio probe output:', error);
    return { hasAudioStream: false };
  }
}

/**
 * Parses ffmpeg's `-progress pipe:1` stream (out_time_us=…) into a percentage
 * of the source duration.
 */
function createProgressReader(
  durationSeconds: number | undefined,
  onProgress: ((percent: number) => void) | undefined,
): ((chunk: string) => void) | undefined {
  if (!onProgress || durationSeconds === undefined || durationSeconds <= 0) {
    return undefined;
  }

  let remainder = '';
  let lastReported = -1;

  return (chunk: string) => {
    const lines = `${remainder}${chunk}`.split('\n');
    remainder = lines.pop() ?? '';

    for (const line of lines) {
      const match = line.match(/^out_time_us=(\d+)\s*$/);

      if (!match) {
        continue;
      }

      const percent = Math.min(100, Math.round((Number(match[1]) / 1_000_000 / durationSeconds) * 100));

      if (percent === lastReported) {
        continue;
      }

      lastReported = percent;
      onProgress(percent);
    }
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

