/**
 * Custom error classes for KV operations
 *
 * Provides typed error handling for KV failures
 */

/**
 * Base class for KV-related errors
 */
export class KVError extends Error {
  constructor(
    message: string,
    public readonly operation: 'read' | 'write' | 'delete' | 'list',
    public readonly key?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'KVError';
  }
}

/**
 * Error thrown when reading from KV fails
 */
export class KVReadError extends KVError {
  constructor(key: string, cause?: Error) {
    super(`Failed to read from KV: ${key}`, 'read', key, cause);
    this.name = 'KVReadError';
  }
}

/**
 * Error thrown when writing to KV fails
 */
export class KVWriteError extends KVError {
  constructor(key: string, cause?: Error) {
    super(`Failed to write to KV: ${key}`, 'write', key, cause);
    this.name = 'KVWriteError';
  }
}

/**
 * Error thrown when deleting from KV fails
 */
export class KVDeleteError extends KVError {
  constructor(key: string, cause?: Error) {
    super(`Failed to delete from KV: ${key}`, 'delete', key, cause);
    this.name = 'KVDeleteError';
  }
}

/**
 * Error thrown when listing KV keys fails
 */
export class KVListError extends KVError {
  constructor(cause?: Error) {
    super('Failed to list KV keys', 'list', undefined, cause);
    this.name = 'KVListError';
  }
}

/**
 * Result type for KV operations
 */
export type KVResult<T> = { success: true; data: T } | { success: false; error: KVError };

/**
 * Wrap a KV operation with error handling
 *
 * @param operation - The async KV operation to perform
 * @param errorFactory - Factory function to create the error
 * @returns Result with data or error
 */
export async function withKVErrorHandling<T>(
  operation: () => Promise<T>,
  errorFactory: (cause: Error) => KVError,
): Promise<KVResult<T>> {
  try {
    const data = await operation();
    return { success: true, data };
  } catch (error) {
    const kvError = errorFactory(error instanceof Error ? error : new Error(String(error)));

    console.error(
      JSON.stringify({
        level: 'error',
        message: kvError.message,
        operation: kvError.operation,
        key: kvError.key,
        cause: kvError.cause?.message,
      }),
    );

    return { success: false, error: kvError };
  }
}

/**
 * Check if an error is a KV-related error
 */
export function isKVError(error: unknown): error is KVError {
  return error instanceof KVError;
}
