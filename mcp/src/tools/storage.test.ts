import { readFileSync, statSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  EdgeRouterClient,
  R2ObjectInfo,
  R2BucketsResponse,
  R2ListResponse,
} from '@bifrost/shared';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));
import {
  listBuckets,
  listObjects,
  getObjectMeta,
  getObject,
  uploadObject,
  deleteObject,
  renameObject,
  moveObject,
  updateObjectMetadata,
} from './storage.js';

describe('Storage tool handlers', () => {
  let mockClient: EdgeRouterClient;

  const mockObjectInfo: R2ObjectInfo = {
    key: 'test-file.txt',
    size: 1024,
    etag: '"abc123"',
    uploaded: '2024-01-01T00:00:00.000Z',
    httpMetadata: {
      contentType: 'text/plain',
      cacheControl: 'public, max-age=3600',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      listBuckets: vi.fn(),
      listObjects: vi.fn(),
      getObjectMeta: vi.fn(),
      downloadObject: vi.fn(),
      uploadObject: vi.fn(),
      deleteObject: vi.fn(),
      renameObject: vi.fn(),
      moveObject: vi.fn(),
      updateObjectMetadata: vi.fn(),
    } as unknown as EdgeRouterClient;
  });

  describe('listBuckets', () => {
    it('returns formatted bucket list', async () => {
      const mockResponse: R2BucketsResponse = {
        buckets: [
          { name: 'files', access: 'read-write' },
          { name: 'bifrost-backups', access: 'read-only' },
        ],
      };
      vi.mocked(mockClient.listBuckets).mockResolvedValue(mockResponse);

      const result = await listBuckets(mockClient);

      expect(result).toContain('R2 Buckets (2 total)');
      expect(result).toContain('files');
      expect(result).toContain('read-write');
      expect(result).toContain('bifrost-backups');
      expect(result).toContain('read-only');
    });

    it('returns message for empty bucket list', async () => {
      vi.mocked(mockClient.listBuckets).mockResolvedValue({ buckets: [] });

      const result = await listBuckets(mockClient);

      expect(result).toContain('No R2 buckets accessible');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listBuckets).mockRejectedValue(new Error('Auth failed'));

      const result = await listBuckets(mockClient);

      expect(result).toContain('Error listing buckets');
      expect(result).toContain('Auth failed');
    });
  });

  describe('listObjects', () => {
    it('returns formatted object list with sizes', async () => {
      const mockResponse: R2ListResponse = {
        objects: [
          { ...mockObjectInfo, key: 'photo.jpg', size: 2048 },
          { ...mockObjectInfo, key: 'doc.pdf', size: 1048576 },
        ],
        truncated: false,
        delimitedPrefixes: [],
      };
      vi.mocked(mockClient.listObjects).mockResolvedValue(mockResponse);

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('Objects in files');
      expect(result).toContain('photo.jpg');
      expect(result).toContain('doc.pdf');
      expect(result).toContain('2.0 KB');
      expect(result).toContain('1.0 MB');
    });

    it('returns message for empty bucket', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('No objects found');
    });

    it('shows prefix in label', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [mockObjectInfo],
        truncated: false,
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, { bucket: 'files', prefix: 'images/' });

      expect(result).toContain('prefix: "images/"');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listObjects).mockRejectedValue(new Error('Bucket not found'));

      const result = await listObjects(mockClient, { bucket: 'bad-bucket' });

      expect(result).toContain('Error listing objects');
      expect(result).toContain('Bucket not found');
    });
  });

  describe('getObjectMeta', () => {
    it('returns formatted metadata', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(mockObjectInfo);

      const result = await getObjectMeta(mockClient, { bucket: 'files', key: 'test-file.txt' });

      expect(result).toContain('Object: test-file.txt');
      expect(result).toContain('Bucket: files');
      expect(result).toContain('1.0 KB');
      expect(result).toContain('Content-Type: text/plain');
      expect(result).toContain('Cache-Control: public, max-age=3600');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getObjectMeta).mockRejectedValue(new Error('Not found'));

      const result = await getObjectMeta(mockClient, { bucket: 'files', key: 'missing.txt' });

      expect(result).toContain('Error getting object metadata');
      expect(result).toContain('Not found');
    });
  });

  describe('getObject', () => {
    it('returns base64 content for small files', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue({ ...mockObjectInfo, size: 100 });
      vi.mocked(mockClient.downloadObject).mockResolvedValue({
        meta: { ...mockObjectInfo, size: 100 },
        body: new TextEncoder().encode('hello world').buffer as ArrayBuffer,
      });

      const result = await getObject(mockClient, { bucket: 'files', key: 'test-file.txt' });

      expect(result).toContain('Object: test-file.txt');
      expect(result).toContain('Content (base64):');
    });

    it('returns metadata-only for large files', async () => {
      const largeMeta = { ...mockObjectInfo, size: 10 * 1024 * 1024 }; // 10MB
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(largeMeta);

      const result = await getObject(mockClient, { bucket: 'files', key: 'big-file.zip' });

      expect(result).toContain('File too large for inline content');
      expect(result).not.toContain('Content (base64):');
    });

    it('returns metadata when metadata_only is true', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(mockObjectInfo);

      const result = await getObject(mockClient, {
        bucket: 'files',
        key: 'test-file.txt',
        metadata_only: true,
      });

      expect(result).toContain('Object: test-file.txt');
      expect(result).not.toContain('Content (base64):');
      // downloadObject should not have been called
      expect(mockClient.downloadObject).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getObjectMeta).mockRejectedValue(new Error('Access denied'));

      const result = await getObject(mockClient, { bucket: 'files', key: 'secret.txt' });

      expect(result).toContain('Error getting object');
      expect(result).toContain('Access denied');
    });
  });

  describe('uploadObject', () => {
    it('returns success message with details', async () => {
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'uploaded.txt',
        size: 50,
      });

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'uploaded.txt',
        content_base64: Buffer.from('test content').toString('base64'),
        content_type: 'text/plain',
      });

      expect(result).toContain('File uploaded successfully');
      expect(result).toContain('Key: uploaded.txt');
      expect(result).toContain('Bucket: files');
    });

    it('rejects files exceeding size limit', async () => {
      // Create a base64 string that decodes to > 25MB
      const largeBuffer = Buffer.alloc(26 * 1024 * 1024);
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'huge.bin',
        content_base64: largeBuffer.toString('base64'),
        content_type: 'application/octet-stream',
      });

      expect(result).toContain('exceeds maximum upload size');
      // Upload should not have been called
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.uploadObject).mockRejectedValue(new Error('Bucket is read-only'));

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'test.txt',
        content_base64: Buffer.from('test').toString('base64'),
        content_type: 'text/plain',
      });

      expect(result).toContain('Error uploading object');
      expect(result).toContain('Bucket is read-only');
    });

    it('uploads from file_path', async () => {
      const fileContent = Buffer.from('file content here');
      vi.mocked(statSync).mockReturnValue({
        isFile: () => true,
        size: fileContent.length,
      } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(fileContent);
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'images/photo.png',
        size: fileContent.length,
      });

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'images/photo.png',
        file_path: '/tmp/photo.png',
      });

      expect(result).toContain('File uploaded successfully');
      expect(result).toContain('Source: /tmp/photo.png');
      expect(mockClient.uploadObject).toHaveBeenCalledWith(
        'files',
        'images/photo.png',
        expect.any(Blob),
        'image/png',
        { overwrite: undefined },
      );
    });

    it('auto-detects content type from extension', async () => {
      vi.mocked(statSync).mockReturnValue({
        isFile: () => true,
        size: 2,
      } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}'));
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'data.json',
        size: 2,
      });

      await uploadObject(mockClient, {
        bucket: 'files',
        key: 'data.json',
        file_path: '/tmp/data.json',
      });

      expect(mockClient.uploadObject).toHaveBeenCalledWith(
        'files',
        'data.json',
        expect.any(Blob),
        'application/json',
        { overwrite: undefined },
      );
    });

    it('uses explicit content_type over auto-detection', async () => {
      vi.mocked(statSync).mockReturnValue({
        isFile: () => true,
        size: 4,
      } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'file.bin',
        size: 4,
      });

      await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.bin',
        file_path: '/tmp/file.png',
        content_type: 'application/octet-stream',
      });

      expect(mockClient.uploadObject).toHaveBeenCalledWith(
        'files',
        'file.bin',
        expect.any(Blob),
        'application/octet-stream',
        { overwrite: undefined },
      );
    });

    it('rejects files exceeding 25MB via file_path before reading', async () => {
      vi.mocked(statSync).mockReturnValue({
        isFile: () => true,
        size: 26 * 1024 * 1024,
      } as ReturnType<typeof statSync>);

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'huge.bin',
        file_path: '/tmp/huge.bin',
        content_type: 'application/octet-stream',
      });

      expect(result).toContain('exceeds maximum upload size');
      expect(readFileSync).not.toHaveBeenCalled();
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors when file not found', async () => {
      vi.mocked(statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'missing.png',
        file_path: '/tmp/missing.png',
      });

      expect(result).toContain('Error: File not found');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors when path is a directory', async () => {
      vi.mocked(statSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof statSync>);

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'dir',
        file_path: '/tmp/somedir',
      });

      expect(result).toContain('Error: Path is not a file');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors on unknown extension without explicit content_type', async () => {
      vi.mocked(statSync).mockReturnValue({
        isFile: () => true,
        size: 4,
      } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('data'));

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.xyz',
        file_path: '/tmp/file.xyz',
      });

      expect(result).toContain('Cannot detect content type');
      expect(result).toContain('.xyz');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors when both file_path and content_base64 provided', async () => {
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.png',
        file_path: '/tmp/file.png',
        content_base64: 'abc123',
      });

      expect(result).toContain('not both');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors when neither file_path nor content_base64 provided', async () => {
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.png',
      });

      expect(result).toContain('Provide either file_path or content_base64');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('errors when content_base64 used without content_type', async () => {
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.png',
        content_base64: Buffer.from('test').toString('base64'),
      });

      expect(result).toContain('content_type is required');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });
  });

  describe('deleteObject', () => {
    it('returns success message', async () => {
      vi.mocked(mockClient.deleteObject).mockResolvedValue(undefined);

      const result = await deleteObject(mockClient, { bucket: 'files', key: 'delete-me.txt' });

      expect(result).toContain('Deleted');
      expect(result).toContain('delete-me.txt');
      expect(result).toContain('files');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.deleteObject).mockRejectedValue(new Error('Object not found'));

      const result = await deleteObject(mockClient, { bucket: 'files', key: 'missing.txt' });

      expect(result).toContain('Error deleting object');
      expect(result).toContain('Object not found');
    });
  });

  describe('renameObject', () => {
    it('returns success message with old and new keys', async () => {
      vi.mocked(mockClient.renameObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'new-name.txt',
      });

      const result = await renameObject(mockClient, {
        bucket: 'files',
        old_key: 'old-name.txt',
        new_key: 'new-name.txt',
      });

      expect(result).toContain('Object renamed successfully');
      expect(result).toContain('From: old-name.txt');
      expect(result).toContain('To: new-name.txt');
      expect(result).toContain('Bucket: files');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.renameObject).mockRejectedValue(new Error('Destination already exists'));

      const result = await renameObject(mockClient, {
        bucket: 'files',
        old_key: 'a.txt',
        new_key: 'b.txt',
      });

      expect(result).toContain('Error renaming object');
      expect(result).toContain('Destination already exists');
    });
  });

  describe('moveObject', () => {
    it('returns success message with source and destination', async () => {
      vi.mocked(mockClient.moveObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'test-file.txt',
      });

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'test-file.txt',
        destination_bucket: 'assets',
      });

      expect(result).toContain('Object moved successfully');
      expect(result).toContain('From: files/test-file.txt');
      expect(result).toContain('To: assets/test-file.txt');
    });

    it('shows custom destination key when provided', async () => {
      vi.mocked(mockClient.moveObject).mockResolvedValue({
        ...mockObjectInfo,
        key: 'new-name.txt',
      });

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'test-file.txt',
        destination_bucket: 'assets',
        destination_key: 'new-name.txt',
      });

      expect(result).toContain('Object moved successfully');
      expect(result).toContain('To: assets/new-name.txt');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.moveObject).mockRejectedValue(new Error('Destination bucket not found'));

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'test.txt',
        destination_bucket: 'invalid',
      });

      expect(result).toContain('Error moving object');
      expect(result).toContain('Destination bucket not found');
    });
  });

  describe('updateObjectMetadata', () => {
    it('returns success message with updated metadata', async () => {
      vi.mocked(mockClient.updateObjectMetadata).mockResolvedValue({
        ...mockObjectInfo,
        httpMetadata: { contentType: 'text/html' },
      });

      const result = await updateObjectMetadata(mockClient, {
        bucket: 'files',
        key: 'test-file.txt',
        content_type: 'text/html',
      });

      expect(result).toContain('Metadata updated successfully');
      expect(result).toContain('Content-Type: text/html');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.updateObjectMetadata).mockRejectedValue(new Error('Object not found'));

      const result = await updateObjectMetadata(mockClient, {
        bucket: 'files',
        key: 'missing.txt',
        content_type: 'text/html',
      });

      expect(result).toContain('Error updating metadata');
      expect(result).toContain('Object not found');
    });
  });
});
