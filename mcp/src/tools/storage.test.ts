import { readFileSync, statSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EdgeRouterClient } from '@bifrost/shared';

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

  const mockObject = {
    key: 'documents/report.pdf',
    size: 1024,
    etag: '"abc123"',
    uploaded: '2024-01-01T00:00:00.000Z',
    httpMetadata: { contentType: 'application/pdf' },
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
      vi.mocked(mockClient.listBuckets).mockResolvedValue({
        buckets: [
          { name: 'files', access: 'read-write' },
          { name: 'assets', access: 'read-only' },
        ],
      });

      const result = await listBuckets(mockClient);

      expect(result).toContain('R2 Buckets (2 total)');
      expect(result).toContain('files (read-write)');
      expect(result).toContain('assets (read-only)');
    });

    it('returns message when no buckets accessible', async () => {
      vi.mocked(mockClient.listBuckets).mockResolvedValue({ buckets: [] });

      const result = await listBuckets(mockClient);

      expect(result).toContain('No R2 buckets accessible');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listBuckets).mockRejectedValue(new Error('Unauthorized'));

      const result = await listBuckets(mockClient);

      expect(result).toContain('Error listing buckets');
      expect(result).toContain('Unauthorized');
    });
  });

  describe('listObjects', () => {
    it('returns formatted object list', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [mockObject],
        truncated: false,
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('Objects in files');
      expect(result).toContain('documents/report.pdf');
      expect(result).toContain('application/pdf');
    });

    it('shows prefix in label', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [mockObject],
        truncated: false,
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, {
        bucket: 'files',
        prefix: 'docs/',
      });

      expect(result).toContain('prefix: "docs/"');
    });

    it('returns message for empty results', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('No objects found in files');
    });

    it('shows truncation cursor when results are truncated', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [mockObject],
        truncated: true,
        cursor: 'next-page-cursor',
        delimitedPrefixes: [],
      });

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('more results available');
      expect(result).toContain('next-page-cursor');
    });

    it('shows delimited prefixes as folders', async () => {
      vi.mocked(mockClient.listObjects).mockResolvedValue({
        objects: [],
        truncated: false,
        delimitedPrefixes: ['images/', 'documents/'],
      });

      const result = await listObjects(mockClient, { bucket: 'files' });

      expect(result).toContain('Folders');
      expect(result).toContain('images/');
      expect(result).toContain('documents/');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.listObjects).mockRejectedValue(new Error('Bucket not found'));

      const result = await listObjects(mockClient, { bucket: 'invalid' });

      expect(result).toContain('Error listing objects');
      expect(result).toContain('Bucket not found');
    });
  });

  describe('getObjectMeta', () => {
    it('returns formatted metadata', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(mockObject);

      const result = await getObjectMeta(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
      });

      expect(result).toContain('Object: documents/report.pdf');
      expect(result).toContain('Bucket: files');
      expect(result).toContain('ETag: "abc123"');
      expect(result).toContain('Content-Type: application/pdf');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getObjectMeta).mockRejectedValue(new Error('Object not found'));

      const result = await getObjectMeta(mockClient, {
        bucket: 'files',
        key: 'missing.pdf',
      });

      expect(result).toContain('Error getting object metadata');
      expect(result).toContain('Object not found');
    });
  });

  describe('getObject', () => {
    it('returns base64 content for small files', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(mockObject);
      vi.mocked(mockClient.downloadObject).mockResolvedValue({
        meta: mockObject,
        body: new ArrayBuffer(1024),
      });

      const result = await getObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
      });

      expect(result).toContain('Object: documents/report.pdf');
      expect(result).toContain('Content (base64)');
    });

    it('returns size warning for large files', async () => {
      const largeObject = { ...mockObject, size: 10 * 1024 * 1024 }; // 10MB
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(largeObject);

      const result = await getObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
      });

      expect(result).toContain('File too large for inline content');
      expect(mockClient.downloadObject).not.toHaveBeenCalled();
    });

    it('returns metadata only when metadata_only is true', async () => {
      vi.mocked(mockClient.getObjectMeta).mockResolvedValue(mockObject);

      const result = await getObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        metadata_only: true,
      });

      expect(result).toContain('Object: documents/report.pdf');
      expect(result).not.toContain('Content (base64)');
      expect(mockClient.downloadObject).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.getObjectMeta).mockRejectedValue(new Error('Access denied'));

      const result = await getObject(mockClient, {
        bucket: 'files',
        key: 'secret.pdf',
      });

      expect(result).toContain('Error getting object');
      expect(result).toContain('Access denied');
    });
  });

  describe('uploadObject', () => {
    it('returns success message', async () => {
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'documents/report.pdf',
        size: 1024,
        etag: '"abc123"',
        uploaded: '2024-01-01T00:00:00.000Z',
      });

      const content = Buffer.from('test content').toString('base64');
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        content_base64: content,
        content_type: 'application/pdf',
      });

      expect(result).toContain('File uploaded successfully');
      expect(result).toContain('Key: documents/report.pdf');
      expect(result).toContain('Bucket: files');
    });

    it('rejects files exceeding 25MB', async () => {
      // Create a base64 string that decodes to > 25MB
      const largeBuffer = Buffer.alloc(26 * 1024 * 1024);
      const content = largeBuffer.toString('base64');

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'large-file.bin',
        content_base64: content,
        content_type: 'application/octet-stream',
      });

      expect(result).toContain('exceeds maximum upload size');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });

    it('shows route creation info when applicable', async () => {
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'documents/report.pdf',
        size: 1024,
        etag: '"abc123"',
        uploaded: '2024-01-01T00:00:00.000Z',
        routeCreated: true,
      });

      const content = Buffer.from('test').toString('base64');
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        content_base64: content,
        content_type: 'application/pdf',
      });

      expect(result).toContain('Route created automatically');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.uploadObject).mockRejectedValue(new Error('Bucket full'));

      const content = Buffer.from('test').toString('base64');
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'doc.pdf',
        content_base64: content,
        content_type: 'application/pdf',
      });

      expect(result).toContain('Error uploading object');
      expect(result).toContain('Bucket full');
    });

    it('uploads from file_path', async () => {
      const fileContent = Buffer.from('file content here');
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(fileContent);
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'images/photo.png',
        size: fileContent.length,
        etag: '"def456"',
        uploaded: '2024-01-01T00:00:00.000Z',
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
        fileContent,
        'image/png',
        { overwrite: undefined },
      );
    });

    it('auto-detects content type from extension', async () => {
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}'));
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'data.json',
        size: 2,
        etag: '"e"',
        uploaded: '2024-01-01T00:00:00.000Z',
      });

      await uploadObject(mockClient, {
        bucket: 'files',
        key: 'data.json',
        file_path: '/tmp/data.json',
      });

      expect(mockClient.uploadObject).toHaveBeenCalledWith(
        'files',
        'data.json',
        expect.any(Buffer),
        'application/json',
        { overwrite: undefined },
      );
    });

    it('uses explicit content_type over auto-detection', async () => {
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('data'));
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'file.bin',
        size: 4,
        etag: '"f"',
        uploaded: '2024-01-01T00:00:00.000Z',
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
        expect.any(Buffer),
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
      vi.mocked(statSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('data'));

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.xyz',
        file_path: '/tmp/file.xyz',
      });

      expect(result).toContain('Cannot detect content type');
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

    it('auto-detects content_type from key when content_base64 used without content_type', async () => {
      vi.mocked(mockClient.uploadObject).mockResolvedValue({
        key: 'file.png',
        size: 4,
        etag: '"abc"',
        uploaded: new Date().toISOString(),
      });

      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.png',
        content_base64: Buffer.from('test').toString('base64'),
      });

      expect(result).toContain('uploaded successfully');
      expect(mockClient.uploadObject).toHaveBeenCalled();
    });

    it('errors when content_base64 used without content_type and unknown extension', async () => {
      const result = await uploadObject(mockClient, {
        bucket: 'files',
        key: 'file.xyz',
        content_base64: Buffer.from('test').toString('base64'),
      });

      expect(result).toContain('Cannot detect content type');
      expect(mockClient.uploadObject).not.toHaveBeenCalled();
    });
  });

  describe('deleteObject', () => {
    it('returns success message', async () => {
      vi.mocked(mockClient.deleteObject).mockResolvedValue(undefined);

      const result = await deleteObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
      });

      expect(result).toContain('Deleted');
      expect(result).toContain('documents/report.pdf');
      expect(result).toContain('files');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.deleteObject).mockRejectedValue(new Error('Object not found'));

      const result = await deleteObject(mockClient, {
        bucket: 'files',
        key: 'missing.pdf',
      });

      expect(result).toContain('Error deleting object');
      expect(result).toContain('Object not found');
    });
  });

  describe('renameObject', () => {
    it('returns success message with old and new keys', async () => {
      vi.mocked(mockClient.renameObject).mockResolvedValue({
        ...mockObject,
        key: 'documents/new-report.pdf',
      });

      const result = await renameObject(mockClient, {
        bucket: 'files',
        old_key: 'documents/report.pdf',
        new_key: 'documents/new-report.pdf',
      });

      expect(result).toContain('Object renamed successfully');
      expect(result).toContain('From: documents/report.pdf');
      expect(result).toContain('To: documents/new-report.pdf');
      expect(result).toContain('Bucket: files');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.renameObject).mockRejectedValue(new Error('Source not found'));

      const result = await renameObject(mockClient, {
        bucket: 'files',
        old_key: 'old.pdf',
        new_key: 'new.pdf',
      });

      expect(result).toContain('Error renaming object');
      expect(result).toContain('Source not found');
    });
  });

  describe('moveObject', () => {
    it('returns success message with source and destination', async () => {
      vi.mocked(mockClient.moveObject).mockResolvedValue({
        ...mockObject,
        key: 'documents/report.pdf',
      });

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        destination_bucket: 'assets',
      });

      expect(result).toContain('Object moved successfully');
      expect(result).toContain('From: files/documents/report.pdf');
      expect(result).toContain('To: assets/documents/report.pdf');
    });

    it('shows custom destination key when provided', async () => {
      vi.mocked(mockClient.moveObject).mockResolvedValue({
        ...mockObject,
        key: 'new-name.pdf',
      });

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        destination_bucket: 'assets',
        destination_key: 'new-name.pdf',
      });

      expect(result).toContain('Object moved successfully');
      expect(result).toContain('To: assets/new-name.pdf');
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.moveObject).mockRejectedValue(new Error('Destination bucket not found'));

      const result = await moveObject(mockClient, {
        bucket: 'files',
        key: 'test.pdf',
        destination_bucket: 'invalid',
      });

      expect(result).toContain('Error moving object');
      expect(result).toContain('Destination bucket not found');
    });
  });

  describe('updateObjectMetadata', () => {
    it('returns success message with updated metadata', async () => {
      vi.mocked(mockClient.updateObjectMetadata).mockResolvedValue({
        ...mockObject,
        httpMetadata: {
          contentType: 'application/pdf',
          cacheControl: 'max-age=3600',
        },
      });

      const result = await updateObjectMetadata(mockClient, {
        bucket: 'files',
        key: 'documents/report.pdf',
        content_type: 'application/pdf',
        cache_control: 'max-age=3600',
      });

      expect(result).toContain('Metadata updated successfully');
      expect(result).toContain('Content-Type: application/pdf');
      expect(result).toContain('Cache-Control: max-age=3600');
    });

    it('passes correct params to client', async () => {
      vi.mocked(mockClient.updateObjectMetadata).mockResolvedValue(mockObject);

      await updateObjectMetadata(mockClient, {
        bucket: 'files',
        key: 'doc.pdf',
        content_type: 'text/plain',
        cache_control: 'no-cache',
        content_disposition: 'attachment; filename=doc.pdf',
      });

      expect(mockClient.updateObjectMetadata).toHaveBeenCalledWith('files', 'doc.pdf', {
        contentType: 'text/plain',
        cacheControl: 'no-cache',
        contentDisposition: 'attachment; filename=doc.pdf',
      });
    });

    it('handles errors gracefully', async () => {
      vi.mocked(mockClient.updateObjectMetadata).mockRejectedValue(new Error('Object not found'));

      const result = await updateObjectMetadata(mockClient, {
        bucket: 'files',
        key: 'missing.pdf',
      });

      expect(result).toContain('Error updating metadata');
      expect(result).toContain('Object not found');
    });
  });
});
