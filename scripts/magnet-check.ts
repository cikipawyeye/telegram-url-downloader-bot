/**
 * Runnable check for the magnet / BitTorrent path: magnet URL extraction and
 * identity, .torrent (bencode) metadata parsing, the aria2 console readout
 * progress parser, and end-to-end expandUrl()/download() runs against a fake
 * `aria2c` binary (metadata phase, per-file selection, progress callbacks,
 * resume fast path, abort, failure reporting and the size cap) so no real
 * swarm is contacted.
 *
 * Run with: npx tsx scripts/magnet-check.ts
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { YtDlp } from 'ytdlp-nodejs';

const TMP_DIR = '/tmp/magnet-check';

// Isolate the metadata cache and point the aria2 probe at the fake binary.
process.env.MAGNET_META_CACHE_DIR = `${TMP_DIR}/meta`;
process.env.ARIA2_BINARY_RECHECK_MS = '150';

const {
  DownloadCancelledError,
  resolveAria2Binary,
  VideoDownloader,
} = await import('../src/video/downloader.js');
const {
  buildMagnetRef,
  extractMagnetInfoHash,
  isMagnetUrl,
  isVideoFileName,
  parseAria2ProgressLine,
  parseMagnetRef,
  parseTorrentMetadata,
  selectLargestVideoFile,
} = await import('../src/video/magnet.js');
const { downloadIdentity, extractUrls, parseVideoRequestItems } = await import('../src/video/utils.js');

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function checkDeepEqual(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
  );
}

// -- fixture torrents ------------------------------------------------------

function bencode(value: number | Buffer | string | Array<unknown> | Record<string, unknown>): Buffer {
  if (typeof value === 'number') {
    return Buffer.from(`i${value}e`);
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  }
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  const parts: Buffer[] = [Buffer.from('d')];
  for (const [key, item] of entries) {
    parts.push(bencode(key), bencode(item as never));
  }
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts);
}

/**
 * Multi-file fixture matching what the fake aria2c writes on download:
 *   1: Pack/ep1.mp4          (4000 B)
 *   2: Pack/season1/ep2.mkv  (6000 B)
 *   3: Pack/notes.txt        (100 B, not a video)
 */
function buildMultiFileTorrent(): { torrent: Buffer; infoHashHex: string } {
  const info = {
    name: 'Pack',
    'piece length': 16384,
    pieces: Buffer.alloc(20),
    files: [
      { length: 4000, path: ['ep1.mp4'] },
      { length: 6000, path: ['season1', 'ep2.mkv'] },
      { length: 100, path: ['notes.txt'] },
    ],
  };
  const torrent = bencode({ announce: 'http://127.0.0.1:6969/announce', info });
  const infoHashHex = crypto.createHash('sha1').update(bencode(info)).digest('hex');
  return { torrent, infoHashHex };
}

function buildSingleFileTorrent(): { torrent: Buffer; infoHashHex: string } {
  const info = { name: 'solo.mp4', 'piece length': 16384, pieces: Buffer.alloc(20), length: 9000 };
  const torrent = bencode({ announce: 'http://127.0.0.1:6969/announce', info });
  const infoHashHex = crypto.createHash('sha1').update(bencode(info)).digest('hex');
  return { torrent, infoHashHex };
}

// -- URL extraction & identity ---------------------------------------------

function checkUrlDetection(): void {
  const magnet = 'magnet:?xt=urn:btih:a1dfefec1a9dd7fa8a041ebeeea271db55126d2f&dn=Pack&tr=https%3A%2F%2Ftracker.example%2Fannounce';

  check(isMagnetUrl(magnet), 'a magnet URI must be detected');
  check(isMagnetUrl('MAGNET:?xt=urn:btih:abc'), 'detection must be case-insensitive');
  for (const url of ['https://youtube.com/watch?v=abc', 'magnet:xt=urn:btih:abc', 'not a url', '']) {
    check(!isMagnetUrl(url), `a non-magnet must not be detected: ${url}`);
  }

  // A magnet must be extracted whole: its embedded tracker URL must NOT leak
  // out as a separate link.
  const mixed = `watch this ${magnet} and also https://youtube.com/watch?v=abc`;
  checkDeepEqual(
    extractUrls(mixed),
    [magnet, 'https://youtube.com/watch?v=abc'],
    'magnet extraction must swallow the embedded tracker URL',
  );

  const items = parseVideoRequestItems(`noproxy ${magnet}\nhttps://a.example/x`);
  checkDeepEqual(
    items,
    [
      { url: magnet, noProxy: true },
      { url: 'https://a.example/x', noProxy: false },
    ],
    'the noproxy marker must apply to magnet links too',
  );

  // Ref round-trip: the #file fragment is internal bookkeeping.
  const ref = buildMagnetRef(magnet, 2);
  check(ref === `${magnet}#file=2`, `buildMagnetRef must tag the file index: ${ref}`);
  const parsed = parseMagnetRef(ref);
  check(parsed.magnet === magnet, `parseMagnetRef must strip the fragment: ${parsed.magnet}`);
  check(parsed.fileIndex === 2, `parseMagnetRef must read the file index: ${parsed.fileIndex}`);

  // Info hash: hex and base32 forms.
  check(
    extractMagnetInfoHash(magnet) === 'a1dfefec1a9dd7fa8a041ebeeea271db55126d2f',
    'the hex info hash must be extracted',
  );
  check(
    extractMagnetInfoHash('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=x') === 'abcdefghijklmnopqrstuvwxyz234567',
    'the base32 info hash must be extracted lowercased',
  );
  check(extractMagnetInfoHash('magnet:?dn=no-hash') === undefined, 'a magnet without btih must yield undefined');

  // Identity: same torrent = same identity even when dn/tr differ; different
  // files of the same torrent stay distinct.
  const sameTorrentOtherTrackers = 'magnet:?dn=Other&tr=udp%3A%2F%2Fother%2Fannounce&xt=urn:btih:A1DFEFEC1A9DD7FA8A041EBEEEA271DB55126D2F';
  check(
    downloadIdentity(magnet) === downloadIdentity(sameTorrentOtherTrackers),
    'the identity must ignore dn/tr and hash case',
  );
  check(
    downloadIdentity(ref) === `${downloadIdentity(magnet)}:file-2`,
    'a file ref must extend the torrent identity',
  );
  check(downloadIdentity(magnet) === 'magnet:a1dfefec1a9dd7fa8a041ebeeea271db55126d2f', 'identity format');
}

// -- torrent metadata parsing ----------------------------------------------

function checkTorrentParsing(): void {
  const multi = parseTorrentMetadata(buildMultiFileTorrent().torrent);
  check(multi.name === 'Pack', `multi-file name: ${multi.name}`);
  checkDeepEqual(
    multi.files,
    [
      { index: 1, pathParts: ['Pack', 'ep1.mp4'], length: 4000 },
      { index: 2, pathParts: ['Pack', 'season1', 'ep2.mkv'], length: 6000 },
      { index: 3, pathParts: ['Pack', 'notes.txt'], length: 100 },
    ],
    'multi-file torrents must list 1-based aria2-style entries',
  );

  const singleFixture = buildSingleFileTorrent();
  const single = parseTorrentMetadata(singleFixture.torrent);
  check(single.name === 'solo.mp4', `single-file name: ${single.name}`);
  checkDeepEqual(
    single.files,
    [{ index: 1, pathParts: ['solo.mp4'], length: 9000 }],
    'single-file torrents must map to one entry',
  );
  check(
    single.infoHashHex === singleFixture.infoHashHex,
    `the info hash must be sha1 of the info dict: ${single.infoHashHex}`,
  );

  // Hostile names must not escape the output directory: separators become
  // underscores and bare `.`/`..` segments collapse to `_`.
  const hostile = parseTorrentMetadata(bencode({
    info: {
      name: '../evil',
      'piece length': 16384,
      pieces: Buffer.alloc(20),
      files: [{ length: 5, path: ['..', 'x/\\y.mp4'] }],
    },
  }));
  check(hostile.name === '.._evil', `a traversal torrent name must be defanged: ${hostile.name}`);
  checkDeepEqual(hostile.files[0].pathParts, ['.._evil', '_', 'x__y.mp4'], 'path parts must be sanitized');

  for (const bad of [Buffer.from('garbage'), Buffer.from(''), bencode({ notinfo: 1 })]) {
    let threw = false;
    try {
      parseTorrentMetadata(bad);
    } catch {
      threw = true;
    }
    check(threw, `malformed metadata must throw: ${JSON.stringify(bad.toString())}`);
  }

  // Video selection helpers.
  check(isVideoFileName('ep2.mkv') && isVideoFileName('clip.MP4') && !isVideoFileName('notes.txt'), 'video file detection');
  const biggest = selectLargestVideoFile(multi.files);
  check(biggest?.index === 2, `the biggest video must win (notes.txt excluded): ${biggest?.index}`);
}

// -- aria2 progress parsing ------------------------------------------------

function checkProgressParsing(): void {
  const full = parseAria2ProgressLine('[#2089b0 400.0KiB/33.2MiB(1%) CN:1 DL:115.7KiB ETA:4m51s]');
  checkDeepEqual(
    full,
    {
      status: 'downloading',
      downloadedBytes: 400 * 1024,
      totalBytes: 33.2 * 1024 * 1024,
      speedBytesPerSecond: 115.7 * 1024,
      etaSeconds: 291,
      percent: 1,
    },
    'a full readout line must parse',
  );

  const noTotal = parseAria2ProgressLine('[#83f00b 0B/0B CN:3 SD:0 DL:0B]');
  checkDeepEqual(
    noTotal,
    {
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes: 0,
      speedBytesPerSecond: 0,
      etaSeconds: undefined,
      percent: undefined,
    },
    'an unknown-total line must parse without percent/eta',
  );

  const computed = parseAria2ProgressLine('[#abc123 25.0MiB/100MiB CN:4 SD:2 DL:2.0MiB ETA:37s]');
  check(computed?.percent === 25, `percent must be computed when absent: ${computed?.percent}`);
  check(computed?.etaSeconds === 37, `short eta must parse: ${computed?.etaSeconds}`);

  const hours = parseAria2ProgressLine('[#abc123 1.00GiB/2.00GiB(50%) CN:4 SD:2 DL:8.0MiB ETA:1h2m3s]');
  check(hours?.etaSeconds === 3723, `h/m/s eta must parse: ${hours?.etaSeconds}`);

  for (const line of ['Downloading metadata...', 'FILE: [MEMORY][METADATA]Pack', '', 'Status Legend:']) {
    check(parseAria2ProgressLine(line) === undefined, `a non-readout line must be ignored: "${line}"`);
  }
}

// -- fake aria2c binary ----------------------------------------------------

/**
 * Behaves just enough like aria2c for the magnet flow: `--version` for the
 * probe, `--bt-metadata-only --bt-save-metadata` copies the fixture torrent
 * into --dir, and `--select-file=N` writes the selected fixture file while
 * printing real-format console readout lines. FAKE_ARIA2_MODE=hang keeps
 * running (abort target), =fail exits non-zero with an error line, =no-save
 * pretends metadata succeeded without saving a .torrent.
 */
const FAKE_ARIA2 = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

if (args.includes('--version')) {
  fs.appendFileSync('${TMP_DIR}/probe-count', 'x');
  process.exit(0);
}

fs.appendFileSync('${TMP_DIR}/spawns.log', args.join(' ') + '\\n');

const dirArg = args.find((a) => a.startsWith('--dir='));
const outputDir = dirArg ? dirArg.slice('--dir='.length) : process.cwd();
fs.mkdirSync(outputDir, { recursive: true });

if (args.some((a) => a.startsWith('--bt-metadata-only'))) {
  if (process.env.FAKE_ARIA2_MODE === 'hang') {
    process.stdout.write('[#aaaaaa 0B/0B CN:0 SD:0 DL:0B]\\\\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.FAKE_ARIA2_MODE === 'fail') {
    process.stderr.write('Exception: [DefaultBtAnnounce.cc:303] errorCode=1 Tracker returned failure reason.\\\\n');
    process.exit(1);
  }
  if (process.env.FAKE_ARIA2_MODE === 'no-save') {
    process.exit(0);
  }
  fs.copyFileSync(process.env.FAKE_ARIA2_FIXTURE, path.join(outputDir, 'fixture.torrent'));
  process.exit(0);
}

const selectArg = args.find((a) => a.startsWith('--select-file='));
const index = Number(selectArg ? selectArg.slice('--select-file='.length) : '1');

if (process.env.FAKE_ARIA2_MODE === 'hang') {
  process.stdout.write('[#bbbbbb 1.00KiB/5.8KiB(17%) CN:2 DL:1.0MiB ETA:4s]\\\\n');
  setInterval(() => {}, 1000);
}
if (process.env.FAKE_ARIA2_MODE === 'fail') {
  process.stderr.write('Exception: errorCode=1 Download aborted.\\\\n');
  process.exit(1);
}

// Fixture layout (see buildMultiFileTorrent in the check script).
const LAYOUT = {
  1: { parts: ['Pack', 'ep1.mp4'], size: 4000 },
  2: { parts: ['Pack', 'season1', 'ep2.mkv'], size: 6000 },
  3: { parts: ['Pack', 'notes.txt'], size: 100 },
};
const file = LAYOUT[index] || LAYOUT[1];
const target = path.join(outputDir, ...file.parts);
fs.mkdirSync(path.dirname(target), { recursive: true });
process.stdout.write('[#cccccc 0B/0B CN:0 SD:0 DL:0B]\\\\n');
process.stdout.write('[#cccccc 2.93KiB/5.86KiB(50%) CN:2 DL:1.0MiB ETA:2s]\\\\n');
fs.writeFileSync(target, Buffer.alloc(file.size));
process.stdout.write('[#cccccc 5.86KiB/5.86KiB(100%) CN:2 DL:0B]\\\\n');
`;

// -- end-to-end with the fake aria2c ---------------------------------------

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDownloader(overrides: { magnetMaxFileBytes?: number } = {}) {
  return new VideoDownloader({
    downloadTimeoutMs: 60_000,
    ytdlp: {} as YtDlp,
    magnetMaxFileBytes: overrides.magnetMaxFileBytes,
  });
}

async function countSpawns(): Promise<number> {
  const log = await fsp.readFile(`${TMP_DIR}/spawns.log`, 'utf8').catch(() => '');
  return log.split('\n').filter((line) => line.trim().length > 0).length;
}

async function checkExpandAndDownload(): Promise<void> {
  await fsp.mkdir(`${TMP_DIR}/bin`, { recursive: true });
  await fsp.writeFile(`${TMP_DIR}/bin/aria2c`, FAKE_ARIA2, { mode: 0o755 });
  process.env.ARIA2_BINARY_PATH = `${TMP_DIR}/bin/aria2c`;

  const fixture = buildMultiFileTorrent();
  const fixturePath = `${TMP_DIR}/fixture.torrent`;
  await fsp.writeFile(fixturePath, fixture.torrent);
  process.env.FAKE_ARIA2_FIXTURE = fixturePath;

  await wait(200); // wait out the shortened binary recheck cooldown
  const binary = await resolveAria2Binary();
  check(binary === `${TMP_DIR}/bin/aria2c`, `the fake aria2c must be detected: ${binary}`);

  const magnet = `magnet:?xt=urn:btih:${fixture.infoHashHex}&dn=Pack&tr=udp%3A%2F%2Ftracker.example%2Fannounce`;
  const downloader = makeDownloader();

  // Expansion: one ref per video file, in torrent order (notes.txt dropped).
  const refs = await downloader.expandUrl(magnet);
  checkDeepEqual(
    refs,
    [`${magnet}#file=1`, `${magnet}#file=2`],
    'expandUrl must return one ref per video file in torrent order',
  );

  const spawnsAfterExpand = await countSpawns();
  check(spawnsAfterExpand === 1, `expansion must fetch metadata once (saw ${spawnsAfterExpand} spawns)`);

  // Download the second video file and resolve it by metadata path.
  const outputDir = `${TMP_DIR}/out`;
  const progressEvents: unknown[] = [];
  const result = await downloader.download({
    url: refs[1],
    outputDir,
    onProgress: (progress) => progressEvents.push(progress),
  });

  check(result.filePath === `${outputDir}/Pack/season1/ep2.mkv`, `the selected file must resolve by metadata path: ${result.filePath}`);
  check(result.fileSize === 6000, `the resolved file must keep its size: ${result.fileSize}`);
  check(result.title === 'ep2', `the title must be the file name without extension: ${result.title}`);
  check(
    progressEvents.some((p) => (p as { percent?: number }).percent === 50),
    `a 50% readout must reach onProgress: ${JSON.stringify(progressEvents)}`,
  );
  check(
    progressEvents.some((p) => (p as { status?: string }).status === 'finished'),
    `a finished event must be emitted last: ${JSON.stringify(progressEvents)}`,
  );

  // A resend of the same file must not hit the swarm again: the complete file
  // is already in the workspace.
  const spawnsAfterDownload = await countSpawns();
  await downloader.download({ url: refs[1], outputDir });
  const spawnsAfterResend = await countSpawns();
  check(
    spawnsAfterResend === spawnsAfterDownload,
    'a completed workspace must skip the swarm on resend',
  );

  // File refs pick their own file, not the biggest one.
  const first = await downloader.download({ url: refs[0], outputDir: `${TMP_DIR}/out-first` });
  check(first.filePath.endsWith('Pack/ep1.mp4'), `#file=1 must select ep1.mp4: ${first.filePath}`);
  check(first.title === 'ep1', `ep1 title: ${first.title}`);
}

async function checkFailurePaths(): Promise<void> {
  const fixture = buildMultiFileTorrent();

  // Metadata fetch failure surfaces aria2's error text. A fresh info hash
  // forces a cache miss (the fixture metadata is cached from the check above).
  process.env.FAKE_ARIA2_MODE = 'fail';
  let message = '';
  try {
    await makeDownloader().expandUrl('magnet:?xt=urn:btih:0000000000000000000000000000000000000001&dn=Fresh');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(/Gagal mengambil metadata torrent/.test(message), `a failed metadata fetch must be reported: ${message}`);
  check(/Tracker returned failure/.test(message), `the aria2 error detail must be included: ${message}`);
  delete process.env.FAKE_ARIA2_MODE;

  // Metadata fetch "succeeds" but saves nothing.
  process.env.FAKE_ARIA2_MODE = 'no-save';
  message = '';
  try {
    await makeDownloader().expandUrl('magnet:?xt=urn:btih:0000000000000000000000000000000000000002&dn=NoSave');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(/Metadata torrent tidak ditemukan/.test(message), `a metadata-less run must be reported: ${message}`);
  delete process.env.FAKE_ARIA2_MODE;

  // A torrent without video files fails with a clear reason (planted straight
  // into the cache to skip the metadata fetch).
  const docsInfo = { name: 'Docs', 'piece length': 16384, pieces: Buffer.alloc(20), files: [{ length: 5, path: ['readme.txt'] }] };
  const noVideoHash = crypto.createHash('sha1').update(bencode(docsInfo)).digest('hex');
  await fsp.mkdir(process.env.MAGNET_META_CACHE_DIR!, { recursive: true });
  await fsp.writeFile(`${process.env.MAGNET_META_CACHE_DIR}/${noVideoHash}.torrent`, bencode({ info: docsInfo }));
  message = '';
  try {
    await makeDownloader().expandUrl(`magnet:?xt=urn:btih:${noVideoHash}&dn=Docs`);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(/tidak berisi file video/.test(message), `a video-less torrent must be reported: ${message}`);

  // Size cap rejects oversized files before touching the swarm.
  message = '';
  try {
    await makeDownloader({ magnetMaxFileBytes: 5000 }).download({
      url: `magnet:?xt=urn:btih:${fixture.infoHashHex}&dn=Pack#file=2`,
      outputDir: `${TMP_DIR}/out-cap`,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check(/melebihi batas/.test(message), `the size cap must reject big files: ${message}`);
}

async function checkAbort(): Promise<void> {
  const fixture = buildMultiFileTorrent();
  const magnet = `magnet:?xt=urn:btih:${fixture.infoHashHex}&dn=Pack#file=1`;

  process.env.FAKE_ARIA2_MODE = 'hang';
  const controller = new AbortController();
  const hangPromise = makeDownloader().download({
    url: magnet,
    outputDir: `${TMP_DIR}/out-hang`,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await hangPromise.then(
    () => {
      throw new Error('the hanging download should have been aborted');
    },
    (error: unknown) => {
      check(
        error instanceof DownloadCancelledError,
        `an aborted download must raise DownloadCancelledError: ${error instanceof Error ? error.message : error}`,
      );
    },
  );
  delete process.env.FAKE_ARIA2_MODE;
}

async function main(): Promise<void> {
  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  await fsp.mkdir(process.env.MAGNET_META_CACHE_DIR!, { recursive: true });

  checkUrlDetection();
  checkTorrentParsing();
  checkProgressParsing();
  await checkExpandAndDownload();
  await checkFailurePaths();
  await checkAbort();

  await fsp.rm(TMP_DIR, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
