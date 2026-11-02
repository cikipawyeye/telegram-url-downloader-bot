import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 4;

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY,
        username     TEXT,
        first_name   TEXT,
        created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        last_seen_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS chats (
        id         INTEGER PRIMARY KEY,
        type       TEXT,
        title      TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      -- Per-chat /convert selection, replaces the in-memory Map so it
      -- survives restarts. Rows expire after a few hours.
      -- ponytail: no FK to chats — this is a cache; pressing a stale button
      -- before any message was recorded must not crash.
      CREATE TABLE IF NOT EXISTS pending_conversions (
        chat_id    INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL,
        height     INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      -- One row per accepted message (batch of URLs). status_message_id is
      -- the Telegram status message that carries the stop button, so cancel
      -- callbacks resolve even after a restart.
      CREATE TABLE IF NOT EXISTS jobs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id           INTEGER NOT NULL,
        user_id           INTEGER,
        status_message_id INTEGER NOT NULL UNIQUE,
        status            TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        convert_height    INTEGER,
        total_urls        INTEGER NOT NULL DEFAULT 0,
        done_urls         INTEGER NOT NULL DEFAULT 0,
        failed_urls       INTEGER NOT NULL DEFAULT 0,
        cancel_requested  INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        finished_at       INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_chat   ON jobs(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status) WHERE status = 'running';

      -- One row per URL inside a job: outcome, metadata, failure reason.
      CREATE TABLE IF NOT EXISTS job_items (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id            INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        url               TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
        error             TEXT,
        title             TEXT,
        file_size_bytes   INTEGER,
        duration_seconds  REAL,
        created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        finished_at       INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id);
    `,
  },
  {
    version: 2,
    sql: `
      -- Per URL: the user asked to bypass the yt-dlp proxy for this link
      -- (the "noproxy" marker / /noproxy in the Telegram message).
      ALTER TABLE job_items ADD COLUMN no_proxy INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 3,
    sql: `
      -- Per URL: workspace directory kept after a failed/cancelled download so
      -- a resend of the same file can resume the leftover partial instead of
      -- starting from zero. NULL once the item succeeds or the partial is
      -- claimed by a newer attempt.
      ALTER TABLE job_items ADD COLUMN resume_dir TEXT;
    `,
  },
  {
    version: 4,
    sql: `
      -- Per URL: the user's tag/label (the /tag command). NULL means untagged.
      -- Values are normalized before they reach the database (lowercase,
      -- punctuation collapsed to "-"), so GROUP BY tag is already canonical.
      ALTER TABLE job_items ADD COLUMN tag TEXT;

      CREATE INDEX IF NOT EXISTS idx_job_items_tag ON job_items(tag);

      -- The tag of the next message, per chat. Same one-shot cache pattern as
      -- pending_conversions: kept in the DB so it survives a restart, and
      -- expired after PENDING_TAG_TTL_SECONDS so a forgotten tag cannot label
      -- downloads days later.
      CREATE TABLE IF NOT EXISTS pending_tags (
        chat_id    INTEGER PRIMARY KEY,
        tag        TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
    `,
  },
];

export class BotDatabase {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---- users & chats ----------------------------------------------------

  touchUser(user: { id?: number; username?: string; first_name?: string }): void {
    if (user.id === undefined) {
      return;
    }

    this.db.prepare(
      `INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = COALESCE(excluded.username, users.username),
         first_name = COALESCE(excluded.first_name, users.first_name),
         last_seen_at = excluded.last_seen_at`,
    ).run(user.id ?? null, user.username ?? null, user.first_name ?? null);
  }

  touchChat(chat: { id?: number; type?: string; title?: string }): void {
    if (chat.id === undefined) {
      return;
    }

    this.db.prepare(
      `INSERT INTO chats (id, type, title) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = COALESCE(excluded.type, chats.type),
         title = COALESCE(excluded.title, chats.title)`,
    ).run(chat.id ?? null, chat.type ?? null, chat.title ?? null);
  }

  // ---- pending conversions ----------------------------------------------

  static readonly PENDING_CONVERSION_TTL_SECONDS = 3 * 60 * 60;

  getPendingConversion(chatId: number): { messageId: number; height: number } | undefined {
    this.expireStalePendingConversions();

    const row = this.db.prepare(
      'SELECT message_id AS messageId, height FROM pending_conversions WHERE chat_id = ?',
    ).get(chatId) as { messageId: number; height: number } | undefined;

    return row;
  }

  setPendingConversion(chatId: number, messageId: number, height: number): void {
    this.db.prepare(
      `INSERT INTO pending_conversions (chat_id, message_id, height) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET message_id = excluded.message_id, height = excluded.height, created_at = excluded.created_at`,
    ).run(chatId, messageId, height);
  }

  deletePendingConversion(chatId: number): void {
    this.db.prepare('DELETE FROM pending_conversions WHERE chat_id = ?').run(chatId);
  }

  private expireStalePendingConversions(): void {
    this.db.prepare(
      'DELETE FROM pending_conversions WHERE created_at < strftime(\'%s\', \'now\') - ?',
    ).run(BotDatabase.PENDING_CONVERSION_TTL_SECONDS);
  }

  // ---- pending tags -----------------------------------------------------

  /** A tag forgotten for a whole hour is stale: the user meant one batch. */
  static readonly PENDING_TAG_TTL_SECONDS = 60 * 60;

  getPendingTag(chatId: number): string | undefined {
    this.expireStalePendingTags();

    const row = this.db
      .prepare('SELECT tag FROM pending_tags WHERE chat_id = ?')
      .get(chatId) as { tag: string } | undefined;

    return row?.tag;
  }

  setPendingTag(chatId: number, tag: string): void {
    this.db.prepare(
      `INSERT INTO pending_tags (chat_id, tag) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET tag = excluded.tag, created_at = excluded.created_at`,
    ).run(chatId, tag);
  }

  deletePendingTag(chatId: number): void {
    this.db.prepare('DELETE FROM pending_tags WHERE chat_id = ?').run(chatId);
  }

  private expireStalePendingTags(): void {
    this.db.prepare(
      'DELETE FROM pending_tags WHERE created_at < strftime(\'%s\', \'now\') - ?',
    ).run(BotDatabase.PENDING_TAG_TTL_SECONDS);
  }

  // ---- jobs -------------------------------------------------------------

  createJob(input: {
    chatId: number;
    userId?: number;
    statusMessageId: number;
    convertHeight?: number;
  }): number {
    const result = this.db.prepare(
      'INSERT INTO jobs (chat_id, user_id, status_message_id, convert_height) VALUES (?, ?, ?, ?)',
    ).run(input.chatId, input.userId ?? null, input.statusMessageId, input.convertHeight ?? null);

    return Number(result.lastInsertRowid);
  }

  setJobTotalUrls(jobId: number, totalUrls: number): void {
    this.db.prepare('UPDATE jobs SET total_urls = ? WHERE id = ?').run(totalUrls, jobId);
  }

  finishJob(jobId: number, status: 'completed' | 'failed' | 'cancelled'): void {
    this.db.prepare(
      `UPDATE jobs SET status = ?, finished_at = strftime('%s', 'now'),
         done_urls = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'done'),
         failed_urls = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'failed')
       WHERE id = ?`,
    ).run(status, jobId, jobId, jobId);
  }

  requestCancelByStatusMessage(statusMessageId: number): boolean {
    const result = this.db.prepare(
      "UPDATE jobs SET cancel_requested = 1 WHERE status_message_id = ? AND status = 'running'",
    ).run(statusMessageId);

    return result.changes > 0;
  }

  isCancelRequested(jobId: number): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(jobId) as
      | { cancel_requested: number }
      | undefined;

    return row?.cancel_requested === 1;
  }

  // ---- job items --------------------------------------------------------

  addItem(jobId: number, url: string, options: { noProxy?: boolean; tag?: string } = {}): number {
    const result = this.db
      .prepare('INSERT INTO job_items (job_id, url, no_proxy, tag) VALUES (?, ?, ?, ?)')
      .run(jobId, url, options.noProxy === true ? 1 : 0, options.tag ?? null);

    return Number(result.lastInsertRowid);
  }

  completeItem(itemId: number, video: { title?: string; fileSize?: number; durationSeconds?: number }): void {
    this.db.prepare(
      `UPDATE job_items SET status = 'done', title = ?, file_size_bytes = ?, duration_seconds = ?,
         finished_at = strftime('%s', 'now') WHERE id = ?`,
    ).run(video.title ?? null, video.fileSize ?? null, video.durationSeconds ?? null, itemId);
  }

  failItem(itemId: number, error: string): void {
    this.db.prepare(
      `UPDATE job_items SET status = 'failed', error = ?, finished_at = strftime('%s', 'now') WHERE id = ?`,
    ).run(error.slice(0, 500), itemId);
  }

  cancelItems(jobId: number): void {
    this.db.prepare(
      `UPDATE job_items SET status = 'cancelled', finished_at = strftime('%s', 'now')
       WHERE job_id = ? AND status = 'pending'`,
    ).run(jobId);
  }

  // ---- tags -------------------------------------------------------------

  /**
   * Tags used in this chat with their download counts, newest use first.
   * `job_items.tag` is already normalized, so no case folding is needed here.
   */
  listTags(chatId: number, limit = 20): Array<{ tag: string; total: number; lastUsedAt: number }> {
    return this.db
      .prepare(
        `SELECT job_items.tag AS tag,
                COUNT(*) AS total,
                MAX(COALESCE(job_items.finished_at, job_items.created_at)) AS lastUsedAt
           FROM job_items JOIN jobs ON jobs.id = job_items.job_id
          WHERE jobs.chat_id = ? AND job_items.tag IS NOT NULL
          GROUP BY job_items.tag
          ORDER BY lastUsedAt DESC, job_items.tag ASC
          LIMIT ?`,
      )
      .all(chatId, limit) as Array<{ tag: string; total: number; lastUsedAt: number }>;
  }

  /** Newest downloads of this chat that carry the tag, for `/tags <nama>`. */
  listItemsByTag(chatId: number, tag: string, limit = 10): Array<{
    url: string;
    title: string | null;
    status: 'pending' | 'done' | 'failed' | 'cancelled';
    fileSizeBytes: number | null;
    finishedAt: number | null;
  }> {
    return this.db
      .prepare(
        `SELECT job_items.url AS url,
                job_items.title AS title,
                job_items.status AS status,
                job_items.file_size_bytes AS fileSizeBytes,
                job_items.finished_at AS finishedAt
           FROM job_items JOIN jobs ON jobs.id = job_items.job_id
          WHERE jobs.chat_id = ? AND job_items.tag = ?
          ORDER BY job_items.id DESC
          LIMIT ?`,
      )
      .all(chatId, tag, limit) as Array<{
        url: string;
        title: string | null;
        status: 'pending' | 'done' | 'failed' | 'cancelled';
        fileSizeBytes: number | null;
        finishedAt: number | null;
      }>;
  }

  // ---- download resume -----------------------------------------------------

  /**
   * Record the workspace directory that holds a partial download for this item.
   * Kept after failure/cancel so a resend of the same file can resume it.
   */
  setItemResumeDir(itemId: number, resumeDir: string): void {
    this.db.prepare('UPDATE job_items SET resume_dir = ? WHERE id = ?').run(resumeDir, itemId);
  }

  clearItemResume(itemId: number): void {
    this.db.prepare('UPDATE job_items SET resume_dir = NULL WHERE id = ?').run(itemId);
  }

  /**
   * Find and claim the most recent failed/cancelled item in this chat whose URL
   * has the same stable file identity, returning its leftover workspace.
   *
   * The claim (`resume_dir = NULL`) only succeeds for one caller, so two
   * concurrent batches cannot resume the same partial. `isMatch` is injected by
   * the caller because identity extraction lives in the video layer.
   */
  takeResumableItem(chatId: number, isMatch: (url: string) => boolean): { itemId: number; resumeDir: string } | undefined {
    const rows = this.db
      .prepare(
        `SELECT job_items.id AS id, job_items.url AS url, job_items.resume_dir AS resume_dir
           FROM job_items JOIN jobs ON jobs.id = job_items.job_id
          WHERE jobs.chat_id = ? AND job_items.resume_dir IS NOT NULL
            AND job_items.status IN ('failed', 'cancelled')
          ORDER BY job_items.id DESC
          LIMIT 50`,
      )
      .all(chatId) as Array<{ id: number; url: string; resume_dir: string }>;

    for (const row of rows) {
      if (!isMatch(row.url)) {
        continue;
      }

      const claim = this.db
        .prepare('UPDATE job_items SET resume_dir = NULL WHERE id = ? AND resume_dir IS NOT NULL')
        .run(row.id);

      if (claim.changes > 0) {
        return { itemId: row.id, resumeDir: row.resume_dir };
      }
    }

    return undefined;
  }

  private migrate(): void {
    const currentVersion = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }

      this.db.exec('BEGIN;');
      try {
        this.db.exec(migration.sql);
        this.db.prepare(`PRAGMA user_version = ${migration.version}`).run();
        this.db.exec('COMMIT;');
      } catch (error) {
        this.db.exec('ROLLBACK;');
        throw error;
      }
    }
  }
}
