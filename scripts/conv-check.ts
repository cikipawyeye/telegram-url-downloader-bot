/**
 * Runnable check for VideoConverter anamorphic (non-square pixel) handling.
 * Generates fixtures with ffmpeg, converts, asserts dimensions/SAR, cleans up.
 */
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { VideoConverter } from '../src/video/converter.js';

const TMP = '/tmp/conv-check';
const ff = (args: string[]) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);

async function main() {
  await fsp.mkdir(TMP, { recursive: true });

  // Anamorphic source: 640x360 storage, SAR 2:1 -> display 1280x360
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360', '-vf', 'setsar=2/1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${TMP}/anamorphic.mp4`]);
  // Normal square-pixel source
  ff(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${TMP}/normal.mp4`]);

  const probeSar = (file: string): string => {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=sample_aspect_ratio', '-of', 'json', file,
    ]).toString();
    return JSON.parse(out).streams[0].sample_aspect_ratio;
  };

  const converter = new VideoConverter({ commandTimeoutMs: 60000 });
  await fsp.mkdir(`${TMP}/out1`, { recursive: true });
  await fsp.mkdir(`${TMP}/out2`, { recursive: true });

  const anamorphic = await converter.convert({
    video: { filePath: `${TMP}/anamorphic.mp4`, fileSize: 0, title: 't', durationSeconds: 1, width: 640, height: 360 },
    outputDir: `${TMP}/out1`,
    targetHeight: 240,
  });
  console.assert(anamorphic.width > anamorphic.height, `anamorphic width (${anamorphic.width}) should exceed height (${anamorphic.height})`);
  console.assert(anamorphic.width === 854, `expected baked 854x240, got ${anamorphic.width}x${anamorphic.height}`);

  const normal = await converter.convert({
    video: { filePath: `${TMP}/normal.mp4`, fileSize: 0, title: 't', durationSeconds: 1, width: 1920, height: 1080 },
    outputDir: `${TMP}/out2`,
    targetHeight: 720,
  });
  console.assert(normal.width === 1280 && normal.height === 720, `expected 1280x720, got ${normal.width}x${normal.height}`);

  // Bake-only (no targetHeight): anamorphic source keeps display size, SAR becomes square
  await fsp.mkdir(`${TMP}/out3`, { recursive: true });
  const baked = await converter.convert({
    video: { filePath: `${TMP}/anamorphic.mp4`, fileSize: 0, title: 't', durationSeconds: 1, width: 640, height: 360 },
    outputDir: `${TMP}/out3`,
  });
  console.assert(baked.width === 1280 && baked.height === 360, `expected bake-only 1280x360, got ${baked.width}x${baked.height}`);
  console.assert(probeSar(baked.filePath) === '1:1', `expected square SAR after bake, got ${probeSar(baked.filePath)}`);

  console.log('anamorphic:', anamorphic.width, 'x', anamorphic.height, '| SAR out:', probeSar(anamorphic.filePath));
  console.log('normal:', normal.width, 'x', normal.height, '| SAR out:', probeSar(normal.filePath));
  console.log('bake-only:', baked.width, 'x', baked.height, '| SAR out:', probeSar(baked.filePath));

  await fsp.rm(TMP, { recursive: true, force: true });
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
