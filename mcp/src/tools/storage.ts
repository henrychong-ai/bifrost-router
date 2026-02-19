/**
 * R2 Storage tool handlers for MCP server
 */

import type { EdgeRouterClient, R2ObjectInfo } from '@bifrost/shared';

/**
 * Format file size for display
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Format R2 object metadata for display
 */
function formatObjectInfo(obj: R2ObjectInfo, bucket: string): string {
  const lines = [
    `Object: ${obj.key}`,
    `Bucket: ${bucket}`,
    `Size: ${formatSize(obj.size)}`,
    `ETag: ${obj.etag}`,
    `Uploaded: ${obj.uploaded}`,
  ];

  if (obj.httpMetadata?.contentType) {
    lines.push(`Content-Type: ${obj.httpMetadata.contentType}`);
  }
  if (obj.httpMetadata?.cacheControl) {
    lines.push(`Cache-Control: ${obj.httpMetadata.cacheControl}`);
  }
  if (obj.httpMetadata?.contentDisposition) {
    lines.push(`Content-Disposition: ${obj.httpMetadata.contentDisposition}`);
  }

  return lines.join('\n');
}

// 5MB threshold for inline content
const INLINE_SIZE_LIMIT = 5 * 1024 * 1024;
// 25MB upload limit
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

/**
 * List accessible R2 buckets
 */
export async function listBuckets(client: EdgeRouterClient): Promise<string> {
  try {
    const response = await client.listBuckets();
    if (response.buckets.length === 0) {
      return 'No R2 buckets accessible with current credentials.';
    }

    const lines = [
      `R2 Buckets (${response.buckets.length} total):`,
      '',
      ...response.buckets.map((b, i) => `${i + 1}. ${b.name} (${b.access})`),
    ];
    return lines.join('\n');
  } catch (error) {
    return `Error listing buckets: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * List objects in an R2 bucket
 */
export async function listObjects(
  client: EdgeRouterClient,
  args: {
    bucket: string;
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
  },
): Promise<string> {
  try {
    const response = await client.listObjects(args.bucket, {
      prefix: args.prefix,
      cursor: args.cursor,
      limit: args.limit,
      delimiter: args.delimiter,
    });

    const lines: string[] = [];
    const label = args.prefix
      ? `Objects in ${args.bucket} (prefix: "${args.prefix}")`
      : `Objects in ${args.bucket}`;

    // Show directories (delimited prefixes) first
    if (response.delimitedPrefixes.length > 0) {
      lines.push(`${label}:`);
      lines.push('');
      lines.push('Folders:');
      response.delimitedPrefixes.forEach(prefix => {
        lines.push(`  ${prefix}`);
      });
    }

    if (response.objects.length > 0) {
      if (lines.length === 0) {
        lines.push(`${label}:`);
        lines.push('');
      }
      lines.push(lines.length > 2 ? '\nFiles:' : 'Files:');
      response.objects.forEach(obj => {
        const size = formatSize(obj.size);
        const type = obj.httpMetadata?.contentType ?? 'unknown';
        lines.push(`  ${obj.key} (${size}, ${type})`);
      });
    }

    if (response.objects.length === 0 && response.delimitedPrefixes.length === 0) {
      return args.prefix
        ? `No objects found in ${args.bucket} with prefix "${args.prefix}".`
        : `No objects found in ${args.bucket}.`;
    }

    if (response.truncated) {
      lines.push('');
      lines.push(`... more results available (use cursor: "${response.cursor}")`);
    }

    return lines.join('\n');
  } catch (error) {
    return `Error listing objects: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get object metadata
 */
export async function getObjectMeta(
  client: EdgeRouterClient,
  args: { bucket: string; key: string },
): Promise<string> {
  try {
    const meta = await client.getObjectMeta(args.bucket, args.key);
    return formatObjectInfo(meta, args.bucket);
  } catch (error) {
    return `Error getting object metadata: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Get object content (with size-based strategy)
 */
export async function getObject(
  client: EdgeRouterClient,
  args: { bucket: string; key: string; metadata_only?: boolean },
): Promise<string> {
  try {
    // Always get metadata first
    const meta = await client.getObjectMeta(args.bucket, args.key);

    if (args.metadata_only) {
      return formatObjectInfo(meta, args.bucket);
    }

    // Check size threshold
    if (meta.size > INLINE_SIZE_LIMIT) {
      return [
        formatObjectInfo(meta, args.bucket),
        '',
        `File too large for inline content (${formatSize(meta.size)} > ${formatSize(INLINE_SIZE_LIMIT)}).`,
        `Use the Bifrost dashboard or direct API to download this file.`,
      ].join('\n');
    }

    // Download and return as base64
    const { body } = await client.downloadObject(args.bucket, args.key);
    const base64 = Buffer.from(body).toString('base64');

    return [formatObjectInfo(meta, args.bucket), '', `Content (base64):`, base64].join('\n');
  } catch (error) {
    return `Error getting object: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Upload object from base64 content
 */
export async function uploadObject(
  client: EdgeRouterClient,
  args: {
    bucket: string;
    key: string;
    content_base64: string;
    content_type: string;
    overwrite?: boolean;
  },
): Promise<string> {
  try {
    // Decode base64 to buffer
    const buffer = Buffer.from(args.content_base64, 'base64');

    // Check size limit
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return `Error: File size (${formatSize(buffer.length)}) exceeds maximum upload size of ${formatSize(MAX_UPLOAD_SIZE)}.`;
    }

    const blob = new Blob([buffer], { type: args.content_type });
    const result = await client.uploadObject(args.bucket, args.key, blob, args.content_type, {
      overwrite: args.overwrite,
    });

    return [
      `File uploaded successfully!`,
      '',
      `Key: ${result.key}`,
      `Bucket: ${args.bucket}`,
      `Size: ${formatSize(result.size)}`,
    ].join('\n');
  } catch (error) {
    return `Error uploading object: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Delete an object
 */
export async function deleteObject(
  client: EdgeRouterClient,
  args: { bucket: string; key: string },
): Promise<string> {
  try {
    await client.deleteObject(args.bucket, args.key);
    return `Deleted: ${args.key} from ${args.bucket}`;
  } catch (error) {
    return `Error deleting object: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Rename/move an object
 */
export async function renameObject(
  client: EdgeRouterClient,
  args: { bucket: string; old_key: string; new_key: string },
): Promise<string> {
  try {
    const result = await client.renameObject(args.bucket, args.old_key, args.new_key);
    return [
      `Object renamed successfully!`,
      '',
      `From: ${args.old_key}`,
      `To: ${result.key}`,
      `Bucket: ${args.bucket}`,
      `Size: ${formatSize(result.size)}`,
    ].join('\n');
  } catch (error) {
    return `Error renaming object: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Update object metadata
 */
export async function updateObjectMetadata(
  client: EdgeRouterClient,
  args: {
    bucket: string;
    key: string;
    content_type?: string;
    cache_control?: string;
    content_disposition?: string;
  },
): Promise<string> {
  try {
    const result = await client.updateObjectMetadata(args.bucket, args.key, {
      contentType: args.content_type,
      cacheControl: args.cache_control,
      contentDisposition: args.content_disposition,
    });

    return [`Metadata updated successfully!`, '', formatObjectInfo(result, args.bucket)].join('\n');
  } catch (error) {
    return `Error updating metadata: ${error instanceof Error ? error.message : String(error)}`;
  }
}
