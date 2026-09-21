/**
 * Runnable check for the per-message "no proxy" override: a Telegram marker
 * (or /noproxy) must reach yt-dlp as an explicit direct connection
 * (`--proxy ""`), which also beats HTTP_PROXY/HTTPS_PROXY from the environment.
 * Uses a fake notifier/downloader + a temp SQLite DB, so no network, yt-dlp or
 * ffmpeg run happens.
 *
 * Run with: npx tsx scripts/no-proxy-check.ts
 */
import fsp from 'node:fs/promises';
import { Bot, type Context, type Update } from 'grammy';
import { YtDlp } from 'ytdlp-nodejs';
import { BotDatabase } from '../src/storage/database.js';
import { registerBotHandlers } from '../src/telegram/register-handlers.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import { VideoDownloader } from '../src/video/downloader.js';
import { VideoMessageProcessor } from '../src/video/process-message.js';
import type { VideoConverter } from '../src/video/converter.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { WorkspaceManager } from '../src/storage/workspace.js';
import { hasNoProxyOverride, parseVideoRequestItems } from '../src/video/utils.js';

const PROXY_URL = 'socks5://127.0.0.1:40000';
const TMP_DIR = '/tmp/no-proxy-check';

type YtDlpDownloadArgs = NonNullable<Parameters<YtDlp['download']>[1]>;
type CapturedDownload = { url: string; noProxy?: boolean };
type CapturedRequest = { text: string; noProxy?: boolean };
type ApiTransformer = Parameters<Bot<Context>['api']['config']['use']>[0];

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function checkMessageParsing(): void {
  const plain = parseVideoRequestItems('https://example.com/a');
  check(plain.length === 1 && !plain[0].noProxy, `a plain link must keep the proxy: ${JSON.stringify(plain)}`);

  for (const marker of ['noproxy', 'no-proxy', 'no proxy', 'tanpa proxy', 'Tanpa Proxy', '!noproxy', '--noproxy', '/noproxy', '#noproxy']) {
    const items = parseVideoRequestItems(`${marker} https://example.com/a`);
    check(
      items.length === 1 && items[0].noProxy,
      `marker "${marker}" should skip the proxy: ${JSON.stringify(items)}`,
    );
  }

  // The marker word must not be picked up from inside a URL.
  check(!hasNoProxyOverride('https://example.com/noproxy'), 'a URL path must not count as the marker');
  check(!hasNoProxyOverride('https://example.com/watch?v=tanpa-proxy'), 'a query value must not count as the marker');

  // A marker on its own line keeps applying to the links that follow.
  const sticky = parseVideoRequestItems('noproxy\nhttps://example.com/a\nhttps://example.com/b');
  check(
    sticky.length === 2 && sticky.every((item) => item.noProxy),
    `a marker line should cover the following links: ${JSON.stringify(sticky)}`,
  );

  // Per-link markers stay scoped to their line; duplicates are still dropped.
  const mixed = parseVideoRequestItems('https://example.com/a\nnoproxy https://example.com/b\nhttps://example.com/a');
  check(mixed.length === 2, `duplicate links should be dropped: ${JSON.stringify(mixed)}`);
  check(mixed[0].url === 'https://example.com/a' && !mixed[0].noProxy, `the first link keeps the proxy: ${JSON.stringify(mixed)}`);
  check(mixed[1].url === 'https://example.com/b' && mixed[1].noProxy, `the marked link skips the proxy: ${JSON.stringify(mixed)}`);
}


async function checkYtDlpArguments(): Promise<void> {
  const captured: YtDlpDownloadArgs[] = [];
  const capturingYtDlp = {
    download(_url: string, options: YtDlpDownloadArgs) {
      captured.push(options);
      return {
        on: () => undefined,
        kill: () => undefined,
        // The download itself is aborted on purpose; only the args matter here.
        run: async (): Promise<never> => {
          throw new Error('args captured');
        },
      };
    },
  };
  const downloader = new VideoDownloader({
    downloadTimeoutMs: 1000,
    proxy: PROXY_URL,
    ytdlp: capturingYtDlp as unknown as YtDlp,
  });

  await downloader
    .download({ url: 'https://example.com/a', outputDir: TMP_DIR, noProxy: true })
    .catch(() => undefined);
  await downloader.download({ url: 'https://example.com/a', outputDir: TMP_DIR }).catch(() => undefined);

  const [direct, proxied] = captured;
  check(direct.proxy === undefined, `a direct download must not pass a proxy: ${JSON.stringify(direct.proxy)}`);
  check(
    Array.isArray(direct.rawArgs) && direct.rawArgs[0] === '--proxy' && direct.rawArgs[1] === '',
    `a direct download must ask yt-dlp for an empty --proxy: ${JSON.stringify(direct.rawArgs)}`,
  );
  check(proxied.proxy === PROXY_URL, `a normal download must keep the proxy: ${JSON.stringify(proxied.proxy)}`);
  check(proxied.rawArgs === undefined, `a normal download must not touch --proxy: ${JSON.stringify(proxied.rawArgs)}`);

  // Render the real command line: an empty --proxy value is yt-dlp's documented
  // "connect directly" switch.
  const directCommand = new YtDlp().download('https://example.com/a', direct).getCommand().split(' ');
  const directIndex = directCommand.indexOf('--proxy');
  check(directIndex !== -1, `the direct command should contain --proxy: ${directCommand.join(' ')}`);
  check(
    directCommand[directIndex + 1] === '',
    `the direct command proxy value must be empty, got "${directCommand[directIndex + 1]}"`,
  );

  const proxiedCommand = new YtDlp().download('https://example.com/a', proxied).getCommand().split(' ');
  const proxiedIndex = proxiedCommand.indexOf('--proxy');
  check(
    proxiedIndex !== -1 && proxiedCommand[proxiedIndex + 1] === PROXY_URL,
    `the normal command should keep the proxy: ${proxiedCommand.join(' ')}`,
  );
}

function buildNotifier(chatId: number) {
  const statuses: string[] = [];
  let noProxyHints = 0;
  let invalidUrls = 0;
  const notifier = {
    chatId,
    async sendAccepted(): Promise<StatusMessage> {
      return { messageId: 700 + chatId };
    },
    async sendInvalidUrl(): Promise<void> {
      invalidUrls += 1;
    },
    async sendNoProxyHint(): Promise<void> {
      noProxyHints += 1;
    },
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {},
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
    },
    async updateProgress(): Promise<void> {},
    canCombineScreenshotsWithVideo(): boolean {
      return false;
    },
    async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async sendScreenshots(): Promise<void> {},
    async sendVideoWithScreenshots(): Promise<void> {},
    async sendVideo(): Promise<void> {},
  };

  return {
    notifier: notifier as unknown as TelegramNotifier,
    statuses,
    hints: () => noProxyHints,
    invalidUrls: () => invalidUrls,
  };
}

function buildProcessor(downloads: CapturedDownload[], db: BotDatabase): VideoMessageProcessor {
  return new VideoMessageProcessor({
    maxFileSizeBytes: 2 * 1024 * 1024,
    videoDownloader: {
      async expandUrl(url: string): Promise<string[]> {
        return [url];
      },
      async download(options: { url: string; noProxy?: boolean }) {
        downloads.push({ url: options.url, noProxy: options.noProxy });

        return {
          filePath: '/tmp/fake-video.mp4',
          fileSize: 1024,
          title: 'Video OK',
          durationSeconds: 5,
          width: 640,
          height: 360,
        };
      },
    } as unknown as VideoDownloader,
    videoScreenshotGenerator: {
      async generate() {
        return [];
      },
      async generateThumbnail() {
        return undefined;
      },
    } as unknown as VideoScreenshotGenerator,
    videoSplitter: {
      async split(video: { filePath: string; fileSize: number; width?: number; height?: number }) {
        return [{
          filePath: video.filePath,
          fileSize: video.fileSize,
          index: 1,
          total: 1,
          width: video.width,
          height: video.height,
        }];
      },
    } as unknown as VideoSplitter,
    videoConverter: undefined as unknown as VideoConverter,
    workspaceManager: {
      async create() {
        return { dirPath: '/tmp/fake-workspace' };
      },
      async remove() {},
    } as unknown as WorkspaceManager,
    screenshotCount: 0,
    sendVideoInAlbum: false,
    reencodeAnamorphic: false,
    db,
  });
}


async function waitForStatus(statuses: string[], pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = statuses.find((text) => pattern.test(text));

    if (match !== undefined) {
      return match;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for a status matching ${pattern}. Seen: ${JSON.stringify(statuses)}`);
}

async function checkDownloadFlow(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  const db = new BotDatabase(`${TMP_DIR}/bot.db`);
  check(
    Number(db.db.prepare('PRAGMA user_version').get()!.user_version) === 2,
    'the job_items.no_proxy migration should have been applied',
  );

  const downloads: CapturedDownload[] = [];
  const processor = buildProcessor(downloads, db);

  // 1) Marker on its own line: every following link skips the proxy.
  const offline = buildNotifier(101);
  await processor.process({
    notifier: offline.notifier,
    text: 'noproxy\nhttps://example.com/a\nhttps://example.com/b',
    userId: '1',
  });
  await waitForStatus(offline.statuses, /^Selesai 1\/2\. Memproses 2\/2 tanpa proxy\.\.\.$/);

  // 2) Mixed message: only the marked link skips the proxy.
  const mixed = buildNotifier(102);
  await processor.process({
    notifier: mixed.notifier,
    text: 'https://example.com/c\nnoproxy https://example.com/d',
    userId: '1',
  });
  await waitForStatus(mixed.statuses, /^Selesai 1\/2\. Memproses 2\/2 tanpa proxy\.\.\.$/);

  // 3) /noproxy forces the direct connection for every link of the message.
  const forced = buildNotifier(103);
  await processor.process({
    notifier: forced.notifier,
    text: 'https://example.com/e',
    userId: '1',
    noProxy: true,
  });
  await waitForStatus(forced.statuses, /^Selesai 0\/1\. Memproses 1\/1 tanpa proxy\.\.\.$/);

  const expected = [
    { url: 'https://example.com/a', noProxy: true },
    { url: 'https://example.com/b', noProxy: true },
    { url: 'https://example.com/c', noProxy: false },
    { url: 'https://example.com/d', noProxy: true },
    { url: 'https://example.com/e', noProxy: true },
  ];

  check(
    JSON.stringify(downloads) === JSON.stringify(expected),
    `downloads should carry the per-link override: ${JSON.stringify(downloads)}`,
  );
  check(
    !mixed.statuses.some((text) => /Memproses 1\/2 tanpa proxy/.test(text)),
    `an unmarked link must not be reported as proxyless: ${JSON.stringify(mixed.statuses)}`,
  );

  const items = db.db.prepare('SELECT url, no_proxy FROM job_items ORDER BY id').all() as Array<{
    url: string;
    no_proxy: number;
  }>;
  check(items.length === expected.length, `every link should be recorded: ${JSON.stringify(items)}`);
  check(
    items.every((item, index) => item.url === expected[index].url && item.no_proxy === (expected[index].noProxy ? 1 : 0)),
    `job items should record the override: ${JSON.stringify(items)}`,
  );

  // 4) Marker without any link: usage hint instead of an "invalid URL" reply.
  const markerOnly = buildNotifier(104);
  await processor.process({ notifier: markerOnly.notifier, text: 'noproxy', userId: '1' });
  check(markerOnly.hints() === 1, 'a marker without a link should explain how to use it');
  check(markerOnly.statuses.length === 0, 'a marker without a link should not start a download');

  const noMarker = buildNotifier(105);
  await processor.process({ notifier: noMarker.notifier, text: 'halo', userId: '1' });
  check(noMarker.invalidUrls() === 1, 'a message without a link keeps the invalid URL reply');
  check(noMarker.hints() === 0, 'a message without the marker must not get the no-proxy hint');

  db.close();
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
}

function buildUpdate(updateId: number, text: string, commandLength?: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Tester' },
      text,
      ...(commandLength === undefined
        ? {}
        : { entities: [{ type: 'bot_command', offset: 0, length: commandLength }] }),
    },
  } as unknown as Update;
}

/**
 * Drive real grammy updates through the registered handlers with an
 * intercepted API, so the /noproxy wiring (and the fact that a plain message is
 * not handled twice) is covered without a Telegram connection.
 */
async function checkHandlerWiring(): Promise<void> {
  const bot = new Bot<Context>('12345:TEST');
  const apiMethods: string[] = [];
  const fakeApi = (async (_prev: unknown, method: string, payload: unknown) => {
    apiMethods.push(method);

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

    return { ok: true, result: { message_id: 1000 + apiMethods.length, text: payload } };
  }) as unknown as ApiTransformer;
  bot.api.config.use(fakeApi);

  await fsp.mkdir(TMP_DIR, { recursive: true });
  const db = new BotDatabase(`${TMP_DIR}/wiring.db`);

  const requests: CapturedRequest[] = [];
  const processor = {
    cancelDownload: () => false,
    async process(request: CapturedRequest) {
      requests.push({ text: request.text, noProxy: request.noProxy });
    },
  } as unknown as VideoMessageProcessor;

  registerBotHandlers(bot, processor, db);
  await bot.init();

  // /noproxy <link>: grammy hands the arguments over as ctx.match.
  await bot.handleUpdate(buildUpdate(1, '/noproxy https://example.com/a', '/noproxy'.length));
  // /noproxy@botname <link> must work in groups too.
  await bot.handleUpdate(buildUpdate(2, '/noproxy@test_bot https://example.com/b', '/noproxy@test_bot'.length));
  // A plain message keeps its raw text; the marker is resolved by the processor.
  await bot.handleUpdate(buildUpdate(3, 'noproxy https://example.com/c'));

  check(
    JSON.stringify(requests) === JSON.stringify([
      { text: 'https://example.com/a', noProxy: true },
      { text: 'https://example.com/b', noProxy: true },
      { text: 'noproxy https://example.com/c', noProxy: false },
    ]),
    `/noproxy and plain messages should reach the processor once each: ${JSON.stringify(requests)}`,
  );

  db.close();
}

async function main(): Promise<void> {
  checkMessageParsing();
  await checkYtDlpArguments();
  await checkDownloadFlow();
  await checkHandlerWiring();

  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});

