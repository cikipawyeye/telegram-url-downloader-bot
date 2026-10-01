/**
 * Runnable check for the HTTP Range resume logic (`streamDownloadToFile`) and
 * the stable download identity used to match a resent link to a leftover
 * partial. Uses fake responses, so no network, yt-dlp or ffmpeg is involved.
 *
 * Run with: npx tsx scripts/resume-check.ts
 */
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { streamDownloadToFile } from '../src/video/downloader.js';
import { downloadIdentity, type VideoDownloadProgress } from '../src/video/utils.js';

const TMP_DIR = '/tmp/resume-check';

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

class FakeResponse {
  constructor(
    private readonly statusCode: number,
    private readonly headers: Record<string, string>,
    private readonly chunks: string[],
  ) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (const chunk of this.chunks) {
      yield Buffer.from(chunk, 'utf8');
    }
  }

  destroy(): void {}
}

type Capture = { requests: Record<string, string>[]; call: number };

function buildCapture(responses: FakeResponse[]): {
  requests: Record<string, string>[];
  call: number;
  request: (headers: Record<string, string>) => Promise<IncomingMessage>;
} {
  const capture: Capture = { requests: [], call: 0 };
  const request = async (headers: Record<string, string>): Promise<IncomingMessage> => {
    capture.requests.push({ ...headers });
    const response = responses[capture.call];
    capture.call += 1;
    if (response === undefined) {
      throw new Error(`unexpected request #${capture.call}`);
    }
    return response as unknown as IncomingMessage;
  };
  return {
    requests: capture.requests,
    // Expose the live counter, not a snapshot taken by the object spread.
    get call() {
      return capture.call;
    },
    request,
  };
}

async function runStream(options: {
  outputPath: string;
  request: (headers: Record<string, string>) => Promise<IncomingMessage>;
}): Promise<{ size: number; progress: VideoDownloadProgress[] }> {
  const progress: VideoDownloadProgress[] = [];
  const size = await streamDownloadToFile({
    request: options.request,
    outputPath: options.outputPath,
    signal: new AbortController().signal,
    isTimedOut: () => false,
    onProgress: (entry) => progress.push(entry),
    mapError: (error) => (error instanceof Error ? error : new Error(String(error))),
  });
  return { size, progress };
}

async function main(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  // 1) 206 resume: a 50-byte partial is continued to a 100-byte file.
  {
    const outputPath = path.join(TMP_DIR, 'resume-206.bin');
    await fsp.writeFile(outputPath, 'A'.repeat(50));
    const capture = buildCapture([
      new FakeResponse(206, { 'content-range': 'bytes 50-99/100', 'content-length': '50' }, ['B'.repeat(25), 'B'.repeat(25)]),
    ]);
    const { size, progress } = await runStream({ outputPath, request: capture.request });

    check(capture.call === 1, `a resumable server must only need one request: ${capture.call}`);
    check(capture.requests[0].range === 'bytes=50-', `the follow-up request must carry the Range header: ${JSON.stringify(capture.requests[0])}`);
    check(size === 100, `the resumed file must be 100 bytes: ${size}`);
    const content = await fsp.readFile(outputPath, 'utf8');
    check(content === `${'A'.repeat(50)}${'B'.repeat(50)}`, `the partial bytes must survive the resume`);
    check(progress[0].downloadedBytes === 75 && progress[0].totalBytes === 100, `progress must count from the partial: ${JSON.stringify(progress[0])}`);
    check(progress.at(-1)?.status === 'finished' && progress.at(-1)?.downloadedBytes === 100, `the final progress must report the full size: ${JSON.stringify(progress.at(-1))}`);
  }

  // 2) The server ignores Range (200): restart from zero with a fresh request.
  {
    const outputPath = path.join(TMP_DIR, 'resume-200.bin');
    await fsp.writeFile(outputPath, 'A'.repeat(50));
    const capture = buildCapture([
      new FakeResponse(200, { 'content-length': '100' }, ['X'.repeat(100)]),
      new FakeResponse(200, { 'content-length': '100' }, ['X'.repeat(100)]),
    ]);
    const { size } = await runStream({ outputPath, request: capture.request });

    check(capture.call === 2, `an ignored Range must trigger a second request: ${capture.call}`);
    check(capture.requests[1].range === undefined, `the restart request must not carry a Range header: ${JSON.stringify(capture.requests[1])}`);
    check(size === 100, `the restarted file must be the fresh content: ${size}`);
    const content = await fsp.readFile(outputPath, 'utf8');
    check(content === 'X'.repeat(100), `the stale partial must be truncated away`);
  }

  // 3) No partial: a plain download without any Range header.
  {
    const outputPath = path.join(TMP_DIR, 'resume-fresh.bin');
    const capture = buildCapture([
      new FakeResponse(200, { 'content-length': '100' }, ['C'.repeat(100)]),
    ]);
    const { size } = await runStream({ outputPath, request: capture.request });

    check(capture.call === 1, `a fresh download must need one request: ${capture.call}`);
    check(capture.requests[0].range === undefined, `a fresh download must not send a Range header: ${JSON.stringify(capture.requests[0])}`);
    check(size === 100, `the fresh file must be complete: ${size}`);
  }

  // 4) 416 with a complete partial: the download is already done.
  {
    const outputPath = path.join(TMP_DIR, 'resume-416-done.bin');
    await fsp.writeFile(outputPath, 'D'.repeat(100));
    const capture = buildCapture([
      new FakeResponse(416, { 'content-range': 'bytes star/100' }, []),
    ]);
    const progress: VideoDownloadProgress[] = [];
    const size = await streamDownloadToFile({
      request: capture.request,
      outputPath,
      signal: new AbortController().signal,
      isTimedOut: () => false,
      onProgress: (entry) => progress.push(entry),
      mapError: (error) => (error instanceof Error ? error : new Error(String(error))),
    });

    check(capture.call === 1, `a complete partial must not trigger a re-download: ${capture.call}`);
    check(size === 100, `the complete partial must be reported as the final size: ${size}`);
    check(progress.at(-1)?.status === 'finished', `the complete partial must emit a finished progress: ${JSON.stringify(progress.at(-1))}`);
  }

  // 5) 206 reporting a total smaller than the partial: restart from zero.
  {
    const outputPath = path.join(TMP_DIR, 'resume-corrupt.bin');
    await fsp.writeFile(outputPath, 'E'.repeat(50));
    const capture = buildCapture([
      new FakeResponse(206, { 'content-range': 'bytes 50-39/40', 'content-length': '0' }, []),
      new FakeResponse(200, { 'content-length': '80' }, ['F'.repeat(80)]),
    ]);
    const { size } = await runStream({ outputPath, request: capture.request });

    check(capture.call === 2, `a shrunken total must trigger a restart: ${capture.call}`);
    check(size === 80, `the restarted file must hold the fresh content: ${size}`);
  }

  // 6) Transport errors are mapped through `mapError`.
  {
    const outputPath = path.join(TMP_DIR, 'resume-error.bin');
    let thrown: Error | undefined;
    try {
      await runStream({
        outputPath,
        request: async () => {
          throw new Error('socket hang up');
        },
      });
    } catch (error) {
      thrown = error instanceof Error ? error : undefined;
    }
    check(thrown?.message === 'socket hang up', `the transport error must be mapped: ${thrown?.message}`);
  }

  // 7) Identity: signed URL variants of the same file share one identity.
  check(
    downloadIdentity('https://bunkr.su/f/abc.mp4') === downloadIdentity('https://dl.bunkr.cr/file/abc.mp4?token=signed&ex=999'),
    'Bunkr /f/<id> and /file/<id> must share an identity',
  );
  check(
    downloadIdentity('https://drive.google.com/file/d/FILE123/view') === downloadIdentity('https://drive.google.com/uc?id=FILE123&export=download'),
    'Drive /file/d/<id> and uc?id=<id> must share an identity',
  );
  check(downloadIdentity('https://example.com/a') === 'https://example.com/a', 'a plain URL is its own identity');
  check(
    downloadIdentity('https://example.com/a?token=1') !== downloadIdentity('https://example.com/a?token=2'),
    'plain URLs with different queries must stay distinct identities',
  );

  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
