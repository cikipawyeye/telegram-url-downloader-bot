/**
 * Runnable check for the download tag feature:
 * - `/tag <nama>` stores a one-shot tag that reaches every job item of the next
 *   link message (bulk and album expansions alike)
 * - `/tags` lists the chat's tags and `/tags <nama>` shows their history
 * - the v4 migration adds `job_items.tag` + `pending_tags`
 *
 * Uses a fake notifier/downloader, an intercepted Telegram API and a temp SQLite
 * DB, so no network, yt-dlp or ffmpeg run happens.
 *
 * Run with: npx tsx scripts/tag-check.ts
 */
import fsp from 'node:fs/promises';
import { Bot, type Context, type Update } from 'grammy';
import type { AudioMessageProcessor } from '../src/audio/process-audio-reply.js';
import { BotDatabase } from '../src/storage/database.js';
import {
  buildTagConfirmation,
  buildTagHistory,
  isTagClearCommand,
  normalizeTag,
} from '../src/tags/tag.js';
import { BOT_COMMANDS, registerBotHandlers } from '../src/telegram/register-handlers.js';
import type { StatusMessage, TelegramNotifier } from '../src/telegram/notifier.js';
import type { VideoConverter } from '../src/video/converter.js';
import type { VideoDownloader } from '../src/video/downloader.js';
import { VideoMessageProcessor } from '../src/video/process-message.js';
import type { VideoScreenshotGenerator } from '../src/video/screenshots.js';
import type { VideoSplitter } from '../src/video/splitter.js';
import type { WorkspaceManager } from '../src/storage/workspace.js';

const TMP_DIR = '/tmp/tag-check';
const WIRING_CHAT_ID = 42;

type ApiTransformer = Parameters<Bot<Context>['api']['config']['use']>[0];
type CapturedRequest = { text: string; tag?: string };
type CapturedApiCall = { method: string; payload: Record<string, unknown> };

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function checkTagNormalization(): void {
  check(normalizeTag('film') === 'film', 'a plain tag must be kept');
  check(normalizeTag('#Film') === 'film', 'a leading # and uppercase must be normalized');
  check(normalizeTag('Film Korea') === 'film-korea', 'spaces must become dashes');
  check(normalizeTag('  film, korea!  ') === 'film-korea', 'punctuation must collapse into one dash');
  check(normalizeTag('film___korea') === 'film___korea', 'underscores are kept');
  check(normalizeTag('film@@') === 'film', 'trailing punctuation must be dropped');
  check(normalizeTag('@#$') === undefined, 'a tag without letters or digits is invalid');
  check(normalizeTag('_') === undefined, 'a tag without letters or digits is invalid');
  check(normalizeTag('   ') === undefined, 'a blank tag is invalid');
  check(
    normalizeTag('a'.repeat(40)) === 'a'.repeat(32),
    'a long tag must be capped at 32 characters',
  );

  for (const clear of ['off', 'OFF', '#off', '-', 'hapus', 'clear', 'reset']) {
    check(isTagClearCommand(clear), `"${clear}" should clear the active tag`);
  }

  check(!isTagClearCommand('film'), 'a normal tag must not clear the active tag');
  check(!isTagClearCommand('offset'), 'a tag starting with "off" must not clear the active tag');

  check(
    buildTagConfirmation('film').includes('Tag "film" aktif untuk unduhan berikutnya.'),
    'the confirmation must name the active tag',
  );
}

function checkDatabase(): void {
  const db = new BotDatabase(`${TMP_DIR}/database.db`);

  check(
    Number(db.db.prepare('PRAGMA user_version').get()!.user_version) === 4,
    'the tag migration (job_items.tag, pending_tags) should have been applied',
  );

  const itemColumns = db.db.prepare('PRAGMA table_info(job_items)').all() as Array<{ name: string }>;
  check(itemColumns.some((column) => column.name === 'tag'), 'job_items.tag must exist');

  const pendingColumns = db.db.prepare('PRAGMA table_info(pending_tags)').all() as Array<{ name: string }>;
  check(
    ['chat_id', 'tag', 'created_at'].every((name) => pendingColumns.some((column) => column.name === name)),
    `pending_tags must have chat_id/tag/created_at: ${JSON.stringify(pendingColumns)}`,
  );

  // ---- pending tag: set / overwrite / clear ---------------------------------
  db.setPendingTag(7, 'film');
  check(db.getPendingTag(7) === 'film', 'a pending tag must be readable');
  db.setPendingTag(7, 'musik');
  check(db.getPendingTag(7) === 'musik', 'setting a tag again must replace it');
  check(db.getPendingTag(8) === undefined, 'another chat must not see the tag');

  db.deletePendingTag(7);
  check(db.getPendingTag(7) === undefined, 'deleting the pending tag must clear it');

  // ---- pending tag: TTL ----------------------------------------------------
  db.setPendingTag(9, 'film');
  db.db
    .prepare('UPDATE pending_tags SET created_at = created_at - ? WHERE chat_id = ?')
    .run(BotDatabase.PENDING_TAG_TTL_SECONDS + 1, 9);
  check(db.getPendingTag(9) === undefined, 'a stale pending tag must expire');

  // ---- items, tag list and per-tag history --------------------------------
  const jobId = db.createJob({ chatId: WIRING_CHAT_ID, statusMessageId: 9001 });
  const first = db.addItem(jobId, 'https://example.com/film-a', { tag: 'film' });
  const second = db.addItem(jobId, 'https://example.com/film-b', { tag: 'film' });
  const untagged = db.addItem(jobId, 'https://example.com/other');
  db.completeItem(first, { title: 'Film A', fileSize: 1024 * 1024, durationSeconds: 10 });
  db.completeItem(second, { title: 'Film B', fileSize: 2 * 1024 * 1024, durationSeconds: 20 });
  db.completeItem(untagged, { title: 'Tanpa tag', fileSize: 4096, durationSeconds: 30 });

  const tags = db.listTags(WIRING_CHAT_ID);
  check(tags.length === 1, `only the tagged items must be grouped: ${JSON.stringify(tags)}`);
  check(tags[0].tag === 'film' && tags[0].total === 2, `the tag must count both items: ${JSON.stringify(tags)}`);

  const history = db.listItemsByTag(WIRING_CHAT_ID, 'film');
  check(history.length === 2, `the history must return both tagged items: ${JSON.stringify(history)}`);
  check(history[0].title === 'Film B', `the history must be newest first: ${JSON.stringify(history)}`);
  check(history[0].status === 'done', 'a completed item must be reported as done');
  check(db.listItemsByTag(WIRING_CHAT_ID, 'musik').length === 0, 'an unused tag has no history');

  const historyText = buildTagHistory('film', history);
  check(
    historyText.includes('Riwayat unduhan dengan tag "film":') && historyText.includes('✅ Film B'),
    `the history message must list the downloads: ${historyText}`,
  );

  // ---- chat isolation ------------------------------------------------------
  const otherJob = db.createJob({ chatId: 43, statusMessageId: 9002 });
  db.addItem(otherJob, 'https://example.com/other-chat', { tag: 'film' });
  check(
    db.listTags(WIRING_CHAT_ID)[0].total === 2,
    'another chat must not change this chat tag count',
  );
  check(db.listTags(43)[0].total === 1, 'the other chat must see its own tag count');
  check(
    db.listItemsByTag(WIRING_CHAT_ID, 'film').length === 2,
    'another chat must not leak into this chat history',
  );

  db.close();
}

function buildNotifier(chatId: number, options: { combineWithVideo?: boolean } = {}) {
  const statuses: string[] = [];
  const accepted: string[] = [];
  const videoCaptions: string[] = [];
  const albumCaptions: string[] = [];
  const screenshotCaptions: Array<string | undefined> = [];
  const notifier = {
    chatId,
    async sendAccepted(text = 'Link diterima. Sedang mencoba mendownload video...'): Promise<StatusMessage> {
      accepted.push(text);
      return { messageId: 700 + chatId };
    },
    async sendInvalidUrl(): Promise<void> {},
    async sendNoProxyHint(): Promise<void> {},
    async addDownloadStopButton(): Promise<void> {},
    async removeDownloadStopButton(): Promise<void> {},
    async deleteStatus(): Promise<void> {},
    async updateStatus(_statusMessage: StatusMessage, text: string): Promise<void> {
      statuses.push(text);
    },
    async updateProgress(): Promise<void> {},
    canCombineScreenshotsWithVideo(): boolean {
      return options.combineWithVideo === true;
    },
    async withMediaSendQueue<T>(task: () => Promise<T>): Promise<T> {
      return await task();
    },
    async sendScreenshots(_screenshots: unknown, caption?: string): Promise<void> {
      screenshotCaptions.push(caption);
    },
    async sendVideoWithScreenshots(_screenshots: unknown, video: { caption: string }): Promise<void> {
      albumCaptions.push(video.caption);
    },
    async sendVideo(video: { caption: string }): Promise<void> {
      videoCaptions.push(video.caption);
    },
  };

  return {
    notifier: notifier as unknown as TelegramNotifier,
    statuses,
    accepted,
    videoCaptions,
    albumCaptions,
    screenshotCaptions,
  };
}

function buildProcessor(
  db: BotDatabase,
  options: { screenshotCount?: number; sendVideoInAlbum?: boolean } = {},
): VideoMessageProcessor {
  const screenshotCount = options.screenshotCount ?? 0;

  return new VideoMessageProcessor({
    maxFileSizeBytes: 2 * 1024 * 1024,
    videoDownloader: {
      async expandUrl(url: string): Promise<string[]> {
        return [url];
      },
      async download() {
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
        return Array.from({ length: screenshotCount }, (_unused, index) => ({
          filePath: `/tmp/fake-screenshot-${index + 1}.jpg`,
          fileName: `screenshot-${index + 1}.jpg`,
        }));
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
    screenshotCount,
    sendVideoInAlbum: options.sendVideoInAlbum === true,
    reencodeAnamorphic: false,
    db,
  });
}

async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = read();

    if (value !== undefined) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * The tag must reach every job item of the message (a bulk message creates one
 * item per link), must show up on the delivered captions, and must not leak into
 * the next message.
 */
async function checkProcessorTag(): Promise<void> {
  const db = new BotDatabase(`${TMP_DIR}/processor.db`);
  const processor = buildProcessor(db, { screenshotCount: 1 });

  const tagged = buildNotifier(55);
  await processor.process({
    notifier: tagged.notifier,
    text: 'https://example.com/a\nhttps://example.com/b',
    userId: '1',
    tag: 'film',
  });

  const taggedItems = await waitFor(() => {
    const rows = db.db
      .prepare(
        `SELECT job_items.tag AS tag, job_items.status AS status
           FROM job_items JOIN jobs ON jobs.id = job_items.job_id
          WHERE jobs.chat_id = ?
          ORDER BY job_items.id`,
      )
      .all(55) as Array<{ tag: string | null; status: string }>;

    return rows.length === 2 && rows.every((row) => row.status === 'done') ? rows : undefined;
  }, 'two tagged items');

  check(
    taggedItems.every((row) => row.tag === 'film'),
    `every link of a tagged message must carry the tag: ${JSON.stringify(taggedItems)}`,
  );
  check(
    tagged.accepted[0]?.includes('Tag: film') === true,
    `the accepted status must mention the tag: ${JSON.stringify(tagged.accepted)}`,
  );

  const taggedVideoCaption = await waitFor(() => tagged.videoCaptions[0], 'tagged video caption');
  check(
    taggedVideoCaption === 'Video OK\n\n#film',
    `the video caption must show the tag: ${JSON.stringify(tagged.videoCaptions)}`,
  );
  check(
    tagged.screenshotCaptions[0] === '#film',
    `the screenshot album must show the tag: ${JSON.stringify(tagged.screenshotCaptions)}`,
  );

  const untagged = buildNotifier(56);
  await processor.process({
    notifier: untagged.notifier,
    text: 'https://example.com/c',
    userId: '1',
  });

  const untaggedItems = await waitFor(() => {
    const rows = db.db
      .prepare(
        `SELECT job_items.tag AS tag, job_items.status AS status
           FROM job_items JOIN jobs ON jobs.id = job_items.job_id
          WHERE jobs.chat_id = ?`,
      )
      .all(56) as Array<{ tag: string | null; status: string }>;

    return rows.length === 1 && rows[0].status === 'done' ? rows : undefined;
  }, 'one untagged item');

  check(
    untaggedItems[0].tag === null,
    `a message without a tag must stay untagged: ${JSON.stringify(untaggedItems)}`,
  );
  check(
    untagged.accepted[0]?.includes('Tag:') !== true,
    `an untagged message must not mention a tag: ${JSON.stringify(untagged.accepted)}`,
  );
  check(
    untagged.videoCaptions[0] === 'Video OK',
    `an untagged video caption must stay unchanged: ${JSON.stringify(untagged.videoCaptions)}`,
  );
  check(
    untagged.screenshotCaptions[0] === undefined,
    `an untagged screenshot album must stay caption-less: ${JSON.stringify(untagged.screenshotCaptions)}`,
  );

  // Album mode (video + screenshots in one media group): the tag lives in the
  // album caption, which is the video's caption because it is the first item.
  const albumProcessor = buildProcessor(db, { screenshotCount: 1, sendVideoInAlbum: true });
  const album = buildNotifier(57, { combineWithVideo: true });
  await albumProcessor.process({
    notifier: album.notifier,
    text: 'https://example.com/d',
    userId: '1',
    tag: 'musik',
  });

  const albumCaption = await waitFor(() => album.albumCaptions[0], 'album caption');
  check(
    albumCaption === 'Video OK\n\n#musik',
    `the album caption must show the tag: ${JSON.stringify(album.albumCaptions)}`,
  );
  check(
    album.screenshotCaptions.length === 0,
    'album mode must not send a separate screenshot album',
  );

  db.close();
}

function buildUpdate(updateId: number, text: string, commandLength?: number): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: WIRING_CHAT_ID, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Tester' },
      text,
      ...(commandLength === undefined
        ? {}
        : { entities: [{ type: 'bot_command', offset: 0, length: commandLength }] }),
    },
  } as unknown as Update;
}

/**
 * Drive real grammy updates through the registered handlers with an intercepted
 * API, so the /tag -> link message wiring, the one-shot behaviour and the
 * /tags listing are covered without a Telegram connection.
 */
async function checkHandlerWiring(): Promise<void> {
  const bot = new Bot<Context>('12345:TEST');
  const calls: CapturedApiCall[] = [];
  const fakeApi = (async (_prev: unknown, method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });

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

    return { ok: true, result: { message_id: 1000 + calls.length, text: payload } };
  }) as unknown as ApiTransformer;
  bot.api.config.use(fakeApi);

  const db = new BotDatabase(`${TMP_DIR}/wiring.db`);
  const requests: CapturedRequest[] = [];
  const processor = {
    cancelDownload: () => false,
    async process(request: CapturedRequest) {
      requests.push({ text: request.text, tag: request.tag });
    },
  } as unknown as VideoMessageProcessor;
  const audioProcessor = {
    cancelDownload: () => false,
    async process() {},
  } as unknown as AudioMessageProcessor;

  registerBotHandlers(bot, processor, db, audioProcessor);
  await bot.init();

  const replyTexts = (): string[] =>
    calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload.text ?? ''));

  // 1) /tag with an argument stores a normalized pending tag.
  await bot.handleUpdate(buildUpdate(1, '/tag Film Korea', '/tag'.length));
  check(db.getPendingTag(WIRING_CHAT_ID) === 'film-korea', 'the /tag command must store the normalized tag');
  check(
    replyTexts().some((text) => text.includes('Tag "film-korea" aktif')),
    `the /tag reply must confirm the tag: ${JSON.stringify(replyTexts())}`,
  );

  // 2) /tag without an argument shows the active tag (and must not clear it).
  await bot.handleUpdate(buildUpdate(2, '/tag', '/tag'.length));
  check(
    replyTexts().some((text) => text.includes('Tag aktif untuk unduhan berikutnya: "film-korea"')),
    `/tag must show the active tag: ${JSON.stringify(replyTexts())}`,
  );

  // 3) The next link message consumes the tag and hands it to the processor.
  await bot.handleUpdate(buildUpdate(3, 'https://example.com/a'));
  check(
    JSON.stringify(requests) === JSON.stringify([{ text: 'https://example.com/a', tag: 'film-korea' }]),
    `the link message must reach the processor with the tag: ${JSON.stringify(requests)}`,
  );
  check(db.getPendingTag(WIRING_CHAT_ID) === undefined, 'the tag is one-shot and must be consumed');

  // 4) A second message without /tag is untagged.
  await bot.handleUpdate(buildUpdate(4, 'https://example.com/b'));
  check(
    requests[1]?.tag === undefined,
    `the tag must not leak into the next message: ${JSON.stringify(requests)}`,
  );

  // 5) /tag off clears the active tag.
  await bot.handleUpdate(buildUpdate(5, '/tag film', '/tag'.length));
  await bot.handleUpdate(buildUpdate(6, '/tag off', '/tag'.length));
  check(db.getPendingTag(WIRING_CHAT_ID) === undefined, '/tag off must clear the active tag');

  // 6) An unusable tag is rejected instead of stored.
  await bot.handleUpdate(buildUpdate(7, '/tag @#$', '/tag'.length));
  check(db.getPendingTag(WIRING_CHAT_ID) === undefined, 'an invalid tag must not be stored');
  check(
    replyTexts().some((text) => text.includes('tidak valid')),
    `an invalid tag must be explained: ${JSON.stringify(replyTexts())}`,
  );

  // 7) /tags lists the tags of the chat (separate command, not /tag).
  await bot.handleUpdate(buildUpdate(8, '/tags', '/tags'.length));
  check(
    replyTexts().some((text) => text.includes('Belum ada tag di chat ini.')),
    `/tags must list the tags: ${JSON.stringify(replyTexts())}`,
  );

  // 8) /tags <nama> shows the tagged history.
  const jobId = db.createJob({ chatId: WIRING_CHAT_ID, statusMessageId: 9003 });
  const itemId = db.addItem(jobId, 'https://example.com/tagged', { tag: 'film' });
  db.completeItem(itemId, { title: 'Judul Film', fileSize: 1024 * 1024, durationSeconds: 60 });
  await bot.handleUpdate(buildUpdate(9, '/tags film', '/tags'.length));
  check(
    replyTexts().some((text) => text.includes('Riwayat unduhan dengan tag "film":')),
    `/tags <nama> must show the history: ${JSON.stringify(replyTexts())}`,
  );

  check(
    BOT_COMMANDS.some((command) => command.command === 'tag') &&
      BOT_COMMANDS.some((command) => command.command === 'tags'),
    'the tag commands must be registered in the Telegram command menu',
  );

  db.close();
}

async function main(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });

  checkTagNormalization();
  checkDatabase();
  await checkProcessorTag();
  await checkHandlerWiring();

  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
