import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  getFileComment,
  listFileComments,
  setFileComment,
  deleteFileComment,
  carryFileComment,
} from '../../src/db/file-comments';

/**
 * Create the file_comments table (mirrors drizzle/0008_file_comments.sql).
 */
async function createTable(db: D1Database) {
  await db
    .prepare(`
    CREATE TABLE IF NOT EXISTS file_comments (
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      comment TEXT NOT NULL,
      updated_by TEXT,
      updated_at INTEGER DEFAULT (unixepoch()) NOT NULL,
      PRIMARY KEY (bucket, key)
    )
  `)
    .run();
}

async function clearTable(db: D1Database) {
  await db.prepare('DELETE FROM file_comments').run();
}

describe('file-comments helper', () => {
  beforeAll(async () => {
    await createTable(env.DB);
  });

  beforeEach(async () => {
    await clearTable(env.DB);
  });

  describe('setFileComment + getFileComment', () => {
    it('upserts a new comment and reads it back', async () => {
      const result = await setFileComment(env.DB, {
        bucket: 'files',
        key: 'a.pdf',
        comment: '  hello note  ',
        updatedBy: 'admin',
      });
      expect(result).toBe('hello note'); // trimmed

      const got = await getFileComment(env.DB, 'files', 'a.pdf');
      expect(got?.comment).toBe('hello note');
      expect(got?.updatedBy).toBe('admin');
      expect(got?.updatedAt).toBeGreaterThan(0);
    });

    it('updates an existing comment (conflict on bucket+key)', async () => {
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'a.pdf',
        comment: 'first',
        updatedBy: 'a',
      });
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'a.pdf',
        comment: 'second',
        updatedBy: 'b',
      });
      const got = await getFileComment(env.DB, 'files', 'a.pdf');
      expect(got?.comment).toBe('second');
      expect(got?.updatedBy).toBe('b');

      // Still a single row for that key.
      const all = await listFileComments(env.DB, 'files', ['a.pdf']);
      expect(all.size).toBe(1);
    });

    it('clears the comment when given empty / whitespace / null', async () => {
      await setFileComment(env.DB, { bucket: 'files', key: 'a.pdf', comment: 'x', updatedBy: 'a' });
      const cleared = await setFileComment(env.DB, {
        bucket: 'files',
        key: 'a.pdf',
        comment: '   ',
        updatedBy: 'a',
      });
      expect(cleared).toBeNull();
      expect(await getFileComment(env.DB, 'files', 'a.pdf')).toBeNull();
    });

    it('returns null for a key with no comment', async () => {
      expect(await getFileComment(env.DB, 'files', 'missing.pdf')).toBeNull();
    });
  });

  describe('listFileComments', () => {
    it('returns an empty map for an empty key list (no query)', async () => {
      const map = await listFileComments(env.DB, 'files', []);
      expect(map.size).toBe(0);
    });

    it('batch-fetches only matching keys within the bucket', async () => {
      await setFileComment(env.DB, { bucket: 'files', key: 'a.pdf', comment: 'A', updatedBy: 'u' });
      await setFileComment(env.DB, { bucket: 'files', key: 'b.pdf', comment: 'B', updatedBy: 'u' });
      await setFileComment(env.DB, {
        bucket: 'assets',
        key: 'a.pdf',
        comment: 'OTHER',
        updatedBy: 'u',
      });

      const map = await listFileComments(env.DB, 'files', ['a.pdf', 'b.pdf', 'c.pdf']);
      expect(map.size).toBe(2);
      expect(map.get('a.pdf')?.comment).toBe('A');
      expect(map.get('b.pdf')?.comment).toBe('B');
      expect(map.has('c.pdf')).toBe(false);
      // Same key in a different bucket is not returned.
      expect(map.get('a.pdf')?.comment).not.toBe('OTHER');
    });
  });

  describe('deleteFileComment', () => {
    it('removes the row', async () => {
      await setFileComment(env.DB, { bucket: 'files', key: 'a.pdf', comment: 'x', updatedBy: 'u' });
      await deleteFileComment(env.DB, 'files', 'a.pdf');
      expect(await getFileComment(env.DB, 'files', 'a.pdf')).toBeNull();
    });

    it('is a no-op (no throw) for a missing key', async () => {
      await expect(deleteFileComment(env.DB, 'files', 'ghost.pdf')).resolves.toBeUndefined();
    });
  });

  describe('carryFileComment', () => {
    it('moves a comment to a new key in the same bucket (rename)', async () => {
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'old.pdf',
        comment: 'note',
        updatedBy: 'u',
      });
      await carryFileComment(env.DB, {
        fromBucket: 'files',
        fromKey: 'old.pdf',
        toBucket: 'files',
        toKey: 'new.pdf',
      });
      expect(await getFileComment(env.DB, 'files', 'old.pdf')).toBeNull();
      expect((await getFileComment(env.DB, 'files', 'new.pdf'))?.comment).toBe('note');
    });

    it('moves a comment across buckets (move)', async () => {
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'doc.pdf',
        comment: 'carry',
        updatedBy: 'u',
      });
      await carryFileComment(env.DB, {
        fromBucket: 'files',
        fromKey: 'doc.pdf',
        toBucket: 'assets',
        toKey: 'moved.pdf',
      });
      expect(await getFileComment(env.DB, 'files', 'doc.pdf')).toBeNull();
      expect((await getFileComment(env.DB, 'assets', 'moved.pdf'))?.comment).toBe('carry');
    });

    it('is a no-op when source has no comment', async () => {
      await carryFileComment(env.DB, {
        fromBucket: 'files',
        fromKey: 'nope.pdf',
        toBucket: 'files',
        toKey: 'dest.pdf',
      });
      expect(await getFileComment(env.DB, 'files', 'dest.pdf')).toBeNull();
    });

    it('is a no-op when source == destination (preserves the comment)', async () => {
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'same.pdf',
        comment: 'keep',
        updatedBy: 'u',
      });
      await carryFileComment(env.DB, {
        fromBucket: 'files',
        fromKey: 'same.pdf',
        toBucket: 'files',
        toKey: 'same.pdf',
      });
      expect((await getFileComment(env.DB, 'files', 'same.pdf'))?.comment).toBe('keep');
    });

    it('overwrites an existing destination comment when carrying', async () => {
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'src.pdf',
        comment: 'fromSrc',
        updatedBy: 'u',
      });
      await setFileComment(env.DB, {
        bucket: 'files',
        key: 'dst.pdf',
        comment: 'oldDst',
        updatedBy: 'u',
      });
      await carryFileComment(env.DB, {
        fromBucket: 'files',
        fromKey: 'src.pdf',
        toBucket: 'files',
        toKey: 'dst.pdf',
      });
      expect((await getFileComment(env.DB, 'files', 'dst.pdf'))?.comment).toBe('fromSrc');
      expect(await getFileComment(env.DB, 'files', 'src.pdf')).toBeNull();
    });
  });
});
