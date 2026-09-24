/**
 * Runnable check for the /audio flow (extract the audio of a video the bot
 * already sent back to the user): the user replies to the video message and
 * types /audio, the bot fetches the video from Telegram, extracts an MP3 and
 * sends it back.
 *
 * - AudioExtractor runs against a real ffmpeg fixture (with and without audio).
 * - TelegramMediaDownloader is tested with a fake Bot API: an absolute local
 *   path (local Bot API server case), a relative path served over HTTP from a
 *   tiny local server, the standard-API 20 MB limit, and mid-download cancel.
 * - AudioMessageProcessor runs end-to-end with a fake media downloader but the
 *   real extractor, workspace manager and database-free notifier fake.
 * - /audio routing goes through real grammy updates with an intercepted API.
 *
 * Run with: npx tsx scripts/audio-check.ts
 */
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { Bot, type Context, type Update } from 'grammy';
import { AudioExtractor } from '../src/audio/extractor.js';
import { AudioMessageProcessor, buildAudioFileName, buildAudioTitle } from '../src/audio/process-audio-reply.js';
import { BotDatabase } from '../src/storage/database.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import { registerBotHandlers } from '../src/telegram/register-handlers.js';
import { TelegramMediaDownloader, videoSourceFromMessage, type TelegramVideoSource } from '../src/telegram/telegram-media.js';
import { DownloadCancelledError } from '../src/video/downloader.js';
import type { VideoMessageProcessor } from '../src/video/process-message.js';
import { WorkspaceManager } from '../src/storage/workspace.js';

const TMP_DIR = '/tmp/audio-check';
const FIXTURE = `${TMP_DIR}/fixture.mp4`;
const SILENT = `${TMP_DIR}/silent.mp4`;

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertRejectedWith(promise: Promise<unknown>, expected: new (...args: never[]) => Error): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(error instanceof expected, `expected ${expected.name}, got: ${error}`);
    return;
  }

  check(false, `expected ${expected.name} but the promise resolved`);
}

function makeFixtures(): void {
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);

  // Video WITH an audio track (8 s, AAC).
  ff([
    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', FIXTURE,
  ]);

  // Video WITHOUT any audio track.
  ff([
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', SILENT,
  ]);
}

async function checkProbeAndExtract(): Promise<void> {
  const extractor = new AudioExtractor({ commandTimeoutMs: 60000 });

  const probe = await extractor.probe(FIXTURE);
  check(probe.hasAudioStream, 'the fixture should be detected as having an audio track');
  check(
    probe.durationSeconds !== undefined && probe.durationSeconds > 7 && probe.durationSeconds < 8.6,
    `fixture duration should be ~8 s, got ${probe.durationSeconds}`,
  );

  const silentProbe = await extractor.probe(SILENT);
  check(!silentProbe.hasAudioStream, 'the silent fixture must be detected as audio-less');

  const percents: number[] = [];
  const audio = await extractor.extract({
    videoPath: FIXTURE,
    outputDir: `${TMP_DIR}/extraction`,
    durationSeconds: probe.durationSeconds,
    onProgress: (percent) => percents.push(percent),
  });

  check(audio.filePath.endsWith('.mp3'), `the extracted file should be an mp3: ${audio.filePath}`);
  check(audio.fileSize > 0, 'the extracted audio must be non-empty');
  check(
    audio.durationSeconds !== undefined && Math.abs(audio.durationSeconds - 8) < 1,
    `the extracted audio duration should be ~8 s, got ${audio.durationSeconds}`,
  );
  check(percents.length > 0, 'the extraction should report progress');
  check(percents[percents.length - 1] === 100, `progress should end at 100, got ${JSON.stringify(percents)}`);

  // The output must be audio-only: no video stream should survive.
  const streams = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'json', audio.filePath,
  ]).toString();
  check(JSON.parse(streams).streams.length === 0, `the mp3 must not contain a video stream: ${streams}`);
}

function checkVideoSourceFromMessage(): void {
  const video = videoSourceFromMessage({
    video: { file_id: 'vid1', file_unique_id: 'u1', width: 1, height: 1, duration: 9, file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 5 },
  } as never);

  check(video?.fileId === 'vid1', `a video message should resolve the file: ${JSON.stringify(video)}`);
  check(video?.fileName === 'clip.mp4' && video.durationSeconds === 9, `video metadata should be kept: ${JSON.stringify(video)}`);

  const document = videoSourceFromMessage({
    document: { file_id: 'doc1', file_unique_id: 'u2', file_name: 'movie.mp4', mime_type: 'video/mp4', file_size: 6 },
  } as never);

  check(document?.fileId === 'doc1', `a video document should resolve the file: ${JSON.stringify(document)}`);

  const image = videoSourceFromMessage({
    document: { file_id: 'img1', file_unique_id: 'u3', file_name: 'pic.jpg', mime_type: 'image/jpeg', file_size: 7 },
  } as never);

  check(image === undefined, `a non-video document must not resolve: ${JSON.stringify(image)}`);
  check(videoSourceFromMessage({} as never) === undefined, 'a message without media must not resolve');
  check(videoSourceFromMessage({ text: 'halo' } as never) === undefined, 'a text message must not resolve');

  const longName = `video ${'x'.repeat(200)}.mp4`;
  check(buildAudioTitle(longName).length <= 64, `the audio title must fit Telegram's 64-char limit: ${buildAudioTitle(longName)}`);
  check(
    buildAudioFileName(longName).endsWith('.mp3') && buildAudioFileName(longName).length <= 125,
    `the audio file name should stay short and keep .mp3: ${buildAudioFileName(longName)}`,
  );
  check(buildAudioTitle('plain.mp4') === 'plain', `the title should drop the extension: ${buildAudioTitle('plain.mp4')}`);
}


function fakeApi(getFileResult: { file_path?: string; file_size?: number }) {
  const calls: string[] = [];

  return {
    calls,
    api: {
      async getFile(fileId: string) {
        calls.push(fileId);
        return { file_id: fileId, file_unique_id: 'unique', ...getFileResult };
      },
    } as never,
  };
}

/** Serves one file content under /file/botTOKEN/<name>, like the Bot API does. */
async function withSlowFileServer(handler: {
  fileName: string;
  serve: (res: ServerResponse) => void | Promise<void>;
}, task: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === `/file/botTEST/${handler.fileName}`) {
      void handler.serve(res);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('failed to start the fake file server');
  }

  try {
    await task(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function checkMediaDownloader(): Promise<void> {
  // 1) Absolute path reachable locally: local Bot API server on this machine.
  const local = fakeApi({ file_path: FIXTURE, file_size: 123 });
  const localDownloader = new TelegramMediaDownloader({
    api: local.api,
    botToken: 'TEST',
    downloadTimeoutMs: 30000,
  });
  await fsp.mkdir(`${TMP_DIR}/media-local`, { recursive: true });

  const copied = await localDownloader.download(
    { fileId: 'vid-local', fileName: 'video.mp4' },
    { dirPath: `${TMP_DIR}/media-local` },
  );

  const fixtureStat = await fsp.stat(FIXTURE);
  check(copied.fileSize === fixtureStat.size, `a local file should be copied as-is: ${JSON.stringify(copied)}`);
  check(copied.fileName === 'video.mp4', `the original file name should be kept: ${JSON.stringify(copied)}`);
  check(copied.filePath.endsWith('.mp4'), `the video extension should be kept: ${copied.filePath}`);

  // 2) Relative path: HTTP download from the configured API root with progress.
  await fsp.mkdir(`${TMP_DIR}/media-http`, { recursive: true });
  const content = await fsp.readFile(FIXTURE);
  const fake = fakeApi({ file_path: 'videos/file_1.mp4', file_size: content.length });

  await withSlowFileServer(
    {
      fileName: 'videos/file_1.mp4',
      serve: (res) => {
        res.setHeader('content-length', String(content.length));
        res.end(content);
      },
    },
    async (baseUrl) => {
      const downloader = new TelegramMediaDownloader({
        api: fake.api,
        botToken: 'TEST',
        apiRoot: baseUrl,
        downloadTimeoutMs: 30000,
      });
      const percents: Array<number | undefined> = [];

      const fetched = await downloader.download(
        { fileId: 'vid-http', fileName: 'video.mp4', fileSize: content.length },
        {
          dirPath: `${TMP_DIR}/media-http`,
          onProgress: (progress) => {
            if (progress.totalBytes !== undefined && progress.totalBytes > 0) {
              percents.push(Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
            }
          },
        },
      );

      check(fetched.fileSize === content.length, `the HTTP file size should match: ${fetched.fileSize}`);
      check(percents.length > 0 && percents[percents.length - 1] === 100, `download progress should end at 100: ${JSON.stringify(percents)}`);
    },
  );

  // 3) Standard Bot API refuses files bigger than 20 MB: fail fast, without
  // ever touching the network.
  const big = fakeApi({ file_path: 'videos/big.mp4', file_size: 25 * 1024 * 1024 });
  const standardDownloader = new TelegramMediaDownloader({
    api: big.api,
    botToken: 'TEST',
    downloadTimeoutMs: 30000,
  });

  try {
    await standardDownloader.download({ fileId: 'vid-big', fileSize: 25 * 1024 * 1024 }, { dirPath: `${TMP_DIR}/media-big` });
    check(false, 'an oversized standard-API file should fail fast');
  } catch (error) {
    check(
      error instanceof Error && error.message.includes('TELEGRAM_API_ROOT') && error.message.includes('20.00 MB'),
      `an oversized standard-API file should explain the limit: ${error}`,
    );
  }

  // 4) Cancelling mid-download must abort the HTTP stream.
  await withSlowFileServer(
    {
      fileName: 'videos/slow.mp4',
      serve: async (res) => {
        res.setHeader('content-length', String(50 * 1024 * 1024));
        res.write(Buffer.alloc(1024, 1));
        await new Promise((resolve) => setTimeout(resolve, 5000));
        res.end();
      },
    },
    async (baseUrl) => {
      await fsp.mkdir(`${TMP_DIR}/media-slow`, { recursive: true });
      const slowFake = fakeApi({ file_path: 'videos/slow.mp4', file_size: 50 * 1024 * 1024 });
      const slowDownloader = new TelegramMediaDownloader({
        api: slowFake.api,
        botToken: 'TEST',
        apiRoot: baseUrl,
        downloadTimeoutMs: 30000,
      });
      const controller = new AbortController();

      const pending = slowDownloader.download(
        { fileId: 'vid-slow', fileSize: 50 * 1024 * 1024 },
        { dirPath: `${TMP_DIR}/media-slow`, signal: controller.signal },
      );

      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort();
      await assertRejectedWith(pending, DownloadCancelledError);
    },
  );
}


function buildAudioNotifier(chatId: number) {
  const statuses: string[] = [];
  const sentAudios: Array<{ filePath: string; fileName: string; title: string; durationSeconds?: number }> = [];
  let audioHints = 0;
  let statusDeleted: StatusMessage | undefined;

  const notifier = {
    chatId,
    async sendAccepted(text?: string): Promise<StatusMessage> {
      const accepted = { messageId: 800 + chatId };
      statuses.push(`accepted:${text}`);
      return accepted;
    },
    async sendInvalidUrl(): Promise<void> {},
    async sendNoProxyHint(): Promise<void> {},
    async sendAudioReplyHint(): Promise<void> {
      audioHints += 1;
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(statusMessage: StatusMessage): Promise<void> {
      statusDeleted = statusMessage;
    },
    async confirmStopped(statusMessage: StatusMessage): Promise<void> {
      statuses.push(`stopped:${statusMessage.messageId}`);
    },
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
    },
    async updateProgress(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
    },
    canCombineScreenshotsWithVideo(): boolean {
      return false;
    },
    async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async sendVideo(): Promise<void> {},
    async sendAudio(audio: { filePath: string; fileName: string; title: string; durationSeconds?: number }) {
      sentAudios.push(audio);
    },
  };

  return {
    notifier: notifier as unknown as TelegramNotifier,
    statuses,
    sentAudios,
    deleted: () => statusDeleted,
    audioHints: () => audioHints,
  };
}


async function checkAudioFlow(): Promise<void> {
  const workspaceManager = new WorkspaceManager(`${TMP_DIR}/workspace`);
  await workspaceManager.prepareRoot();
  const extractor = new AudioExtractor({ commandTimeoutMs: 60000 });

  const processor = new AudioMessageProcessor({
    // The fixture already sits on disk; the fake downloader "fetches" it.
    mediaDownloader: {
      async download(media: TelegramVideoSource, options: { dirPath: string }) {
        const fetchedPath = `${options.dirPath}/telegram-video.mp4`;
        await fsp.copyFile(media.fileId === 'silent' ? SILENT : FIXTURE, fetchedPath);
        const stat = await fsp.stat(fetchedPath);

        return { filePath: fetchedPath, fileName: 'Judul Video.mp4', fileSize: stat.size };
      },
    } as unknown as TelegramMediaDownloader,
    audioExtractor: extractor,
    workspaceManager,
    maxFileSizeBytes: 100 * 1024 * 1024,
  });

  // 1) Happy path: statuses flow, the mp3 is sent with the video's title.
  const happy = buildAudioNotifier(201);
  await processor.process({ notifier: happy.notifier, media: { fileId: 'video' }, userId: '1' });

  check(happy.sentAudios.length === 1, `one audio should be sent: ${JSON.stringify(happy.sentAudios)}`);
  const sent = happy.sentAudios[0];
  check(sent.filePath.endsWith('.mp3'), `the sent file should be an mp3: ${sent.filePath}`);
  check(sent.fileName === 'Judul Video.mp3', `the file name should follow the video: ${sent.fileName}`);
  check(sent.title === 'Judul Video', `the title should drop the extension: ${sent.title}`);
  check(
    sent.durationSeconds !== undefined && Math.abs(sent.durationSeconds - 8) < 1,
    `the duration should be ~8 s, got ${sent.durationSeconds}`,
  );
  check(
    happy.statuses.some((text) => text.includes('Mengambil video dari Telegram')),
    `the flow should mention the Telegram fetch: ${JSON.stringify(happy.statuses)}`,
  );
  check(
    happy.statuses.some((text) => text.includes('Sedang mengirim audio ke Telegram')),
    `the flow should mention sending the audio: ${JSON.stringify(happy.statuses)}`,
  );
  check(happy.deleted() !== undefined, 'the status message should be removed after a successful send');

  // 2) A video without an audio track fails with a reason in the status message.
  const silent = buildAudioNotifier(202);
  await processor.process({ notifier: silent.notifier, media: { fileId: 'silent' }, userId: '1' });

  check(silent.sentAudios.length === 0, 'no audio may be sent when there is no track');
  const failure = silent.statuses.find((text) => text.startsWith('Gagal mengekstrak audio: '));
  check(
    failure?.includes('tidak punya track audio') === true,
    `the failure reason should be shown: ${JSON.stringify(silent.statuses)}`,
  );
}


async function checkAudioCancel(): Promise<void> {
  const workspaceManager = new WorkspaceManager(`${TMP_DIR}/workspace-cancel`);
  await workspaceManager.prepareRoot();

  const audio = buildAudioNotifier(203);

  const processor = new AudioMessageProcessor({
    // A downloader that never finishes until the signal fires.
    mediaDownloader: {
      download(_media: TelegramVideoSource, options: { signal?: AbortSignal }) {
        return new Promise<never>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new DownloadCancelledError());
            return;
          }

          options.signal?.addEventListener('abort', () => reject(new DownloadCancelledError()), { once: true });
        });
      },
    } as unknown as TelegramMediaDownloader,
    audioExtractor: new AudioExtractor({ commandTimeoutMs: 60000 }),
    workspaceManager,
    maxFileSizeBytes: 100 * 1024 * 1024,
  });

  const pending = processor.process({ notifier: audio.notifier, media: { fileId: 'video' }, userId: '1' });

  // Wait until the Telegram fetch has been announced, then request a cancel.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !audio.statuses.some((text) => text === 'Mengambil video dari Telegram...')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const cancelled = processor.cancelDownload(800 + 203);
  check(cancelled, 'cancelling the audio download should return true');
  await pending;

  check(audio.sentAudios.length === 0, 'no audio may be sent after a cancel');
  check(
    audio.statuses.some((text) => text === 'stopped:1003'),
    `the cancel should be confirmed: ${JSON.stringify(audio.statuses)}`,
  );
}

function buildReplyUpdate(updateId: number, text: string, replyTo?: object, commandLength?: number): Update {
  const message: Record<string, unknown> = {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: 'private' },
    from: { id: 7, is_bot: false, first_name: 'Tester' },
    text,
    ...(replyTo === undefined ? {} : { reply_to_message: replyTo }),
    ...(commandLength === undefined
      ? {}
      : { entities: [{ type: 'bot_command', offset: 0, length: commandLength }] }),
  };

  return { update_id: updateId, message } as unknown as Update;
}

type CapturedAudioRequest = { media: TelegramVideoSource; userId: string };
type CapturedVideoRequest = Record<string, unknown>;
type ApiTransformer = Parameters<Bot<Context>['api']['config']['use']>[0];


async function checkAudioHandlerWiring(): Promise<void> {
  const bot = new Bot<Context>('12345:TEST');
  const sentTexts: string[] = [];
  const fakeApi = (async (_prev: unknown, method: string, payload: unknown) => {
    if (method === 'getMe') {
      return {
        ok: true,
        result: {
          id: 1,
          is_bot: true,
          first_name: 'Test',
          username: 'test_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        },
      };
    }

    if (method === 'sendMessage') {
      sentTexts.push((payload as { text?: string }).text ?? '');
    }

    return { ok: true, result: { message_id: 900 + sentTexts.length } };
  }) as unknown as ApiTransformer;
  bot.api.config.use(fakeApi);

  await fsp.mkdir(TMP_DIR, { recursive: true });
  const db = new BotDatabase(`${TMP_DIR}/wiring.db`);

  const videoRequests: CapturedVideoRequest[] = [];
  const videoProcessor = {
    cancelDownload: () => false,
    async process(request: CapturedVideoRequest) {
      videoRequests.push(request);
    },
  } as unknown as VideoMessageProcessor;

  const audioRequests: CapturedAudioRequest[] = [];
  const audioProcessor = {
    cancelDownload: () => false,
    async process(request: { media: TelegramVideoSource; userId: string }) {
      audioRequests.push({ media: request.media, userId: request.userId });
    },
  } as unknown as AudioMessageProcessor;

  registerBotHandlers(bot, videoProcessor, db, audioProcessor);
  await bot.init();

  const repliedVideo = {
    message_id: 50,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 42, type: 'private' },
    from: { id: 1, is_bot: true, first_name: 'Bot' },
    video: { file_id: 'vid-replied', file_unique_id: 'u', width: 1, height: 1, duration: 5, file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 10 },
  };

  // 1) /audio as a reply to a video: the audio flow starts with the file.
  await bot.handleUpdate(buildReplyUpdate(1, '/audio', repliedVideo, '/audio'.length));

  // 2) /audio without a reply: usage hint, no audio job.
  await bot.handleUpdate(buildReplyUpdate(2, '/audio', undefined, '/audio'.length));

  // 3) A plain link stays on the video flow, untouched by the audio wiring.
  await bot.handleUpdate(buildReplyUpdate(3, 'https://example.com/v'));

  check(
    JSON.stringify(audioRequests) === JSON.stringify([
      {
        media: { fileId: 'vid-replied', fileName: 'clip.mp4', fileSize: 10, durationSeconds: 5 },
        userId: '7',
      },
    ]),
    `/audio on a video reply should start the audio flow: ${JSON.stringify(audioRequests)}`,
  );
  check(videoRequests.length === 1, `the plain link should only hit the video flow: ${JSON.stringify(videoRequests)}`);
  check(
    sentTexts.some((text) => text.includes('/audio')),
    `a missing reply should answer with the /audio hint: ${JSON.stringify(sentTexts)}`,
  );

  db.close();
}

async function main(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(`${TMP_DIR}/extraction`, { recursive: true });
  makeFixtures();

  checkVideoSourceFromMessage();
  await checkProbeAndExtract();
  await checkMediaDownloader();
  await checkAudioFlow();
  await checkAudioCancel();
  await checkAudioHandlerWiring();

  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

