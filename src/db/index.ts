import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/**
 * Create a Drizzle ORM instance for D1
 *
 * @param db - D1Database binding from Worker env
 * @returns Drizzle ORM instance with schema
 */
export function createDb(db: D1Database) {
  return drizzle(db, { schema });
}

/**
 * Database type for use in function signatures
 */
export type Database = ReturnType<typeof createDb>;

// Re-export schema types
export * from './schema';
