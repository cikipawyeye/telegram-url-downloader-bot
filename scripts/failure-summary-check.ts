/**
 * Runnable check for the failure reporting helpers used by the Telegram status
 * message: error reasons must reach the user, stay single-line and stay inside
 * the Telegram message limit (an over-long edit fails silently).
 */
import { buildFailureSummary, summarizeErrorMessage, type BatchFailure } from '../src/video/utils.js';

const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  // Multi-line stderr must be collapsed so the reason fits one Telegram line.
  const multiLine = summarizeErrorMessage(new Error('ffmpeg error\n  line two\r\nline three'));
  check(!multiLine.includes('\n'), `reason should be single line, got: ${JSON.stringify(multiLine)}`);
  check(multiLine === 'ffmpeg error line two line three', `unexpected collapsed reason: ${multiLine}`);

  // yt-dlp errors carry the reason in the message and must be forwarded as-is.
  const ytDlpError = summarizeErrorMessage(new Error('yt-dlp exited with code 1: ERROR: [youtube] abc: Video unavailable'));
  check(ytDlpError.includes('Video unavailable'), `reason should keep the yt-dlp error, got: ${ytDlpError}`);

  // Raw stderr dumps must be truncated, not sent in full.
  const longReason = summarizeErrorMessage(new Error('x'.repeat(2000)));
  check(longReason.length === 300, `reason should be capped at 300 chars, got ${longReason.length}`);
  check(longReason.endsWith('…'), `truncated reason should end with an ellipsis, got: ${longReason.slice(-5)}`);

  // Errors without a message still produce something readable.
  check(summarizeErrorMessage('') === 'Alasan tidak diketahui.', 'empty error should fall back to a generic reason');
  check(summarizeErrorMessage(new Error('   ')) === 'Alasan tidak diketahui.', 'blank error should fall back to a generic reason');
  check(summarizeErrorMessage('plain string error') === 'plain string error', 'non-Error values should be stringified');

  // Single URL failure: no more bare "0/1 berhasil" without the reason.
  const single = buildFailureSummary('Gagal memproses link:', [
    { url: 'https://example.com/video', reason: 'yt-dlp exited with code 1: ERROR: Video unavailable' },
  ]);
  check(single.startsWith('Gagal memproses link:'), `unexpected single failure header: ${single}`);
  check(single.includes('1. https://example.com/video — '), `single failure should list the link: ${single}`);
  check(single.includes('Video unavailable'), `single failure should include the reason: ${single}`);

  // Bulk summary keeps the counters and adds one line per failed link.
  const bulk = buildFailureSummary('Bulk selesai: 1/3 berhasil, 2 gagal.', [
    { url: 'https://example.com/a', reason: 'Proses download timeout setelah 9000 detik.' },
    { url: 'https://example.com/b', reason: 'Video terlalu besar untuk dipecah.' },
  ]);
  check(bulk.includes('Bulk selesai: 1/3 berhasil, 2 gagal.'), `bulk header missing: ${bulk}`);
  check(bulk.includes('1. https://example.com/a — Proses download timeout setelah 9000 detik.'), `bulk detail 1 missing: ${bulk}`);
  check(bulk.includes('2. https://example.com/b — Video terlalu besar untuk dipecah.'), `bulk detail 2 missing: ${bulk}`);

  // Long URLs and reasons stay bounded.
  const longUrl = `https://example.com/${'p'.repeat(500)}`;
  const bounded = buildFailureSummary('Gagal memproses link:', [{ url: longUrl, reason: longReason }]);
  check(bounded.length < TELEGRAM_MESSAGE_MAX_LENGTH, `summary should stay under the Telegram limit, got ${bounded.length}`);
  check(bounded.includes('…'), 'bounded summary should mark the truncated url/reason');

  // A batch with many failures must still be delivered: overflow entries are
  // replaced by a count so the message never exceeds Telegram's limit.
  const manyFailures: BatchFailure[] = Array.from({ length: 40 }, (_unused, index) => ({
    url: `https://example.com/video-${index + 1}`,
    reason: `ERROR: ${'e'.repeat(300)}`,
  }));
  const overflow = buildFailureSummary('Bulk selesai: 0/40 berhasil, 40 gagal.', manyFailures);
  check(overflow.length <= 3500, `overflow summary should be capped, got ${overflow.length}`);
  check(/…dan \d+ link lain gagal\.$/.test(overflow), `overflow summary should count the dropped links: ${overflow.slice(-60)}`);
  check(overflow.includes('1. https://example.com/video-1'), 'overflow summary should keep the first failed link');

  console.log('single:', JSON.stringify(single));
  console.log('bulk:', JSON.stringify(bulk));
  console.log('overflow tail:', JSON.stringify(overflow.slice(-80)), '| length:', overflow.length);
  console.log('ALL CHECKS PASSED');
}

try {
  main();
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
}
