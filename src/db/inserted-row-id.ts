import { isRecord } from '../utils/boundary';

/**
 * The id of the row a D1 insert wrote, from its run result's
 * `meta.last_row_id`, when D1 reports one (v1.47.0): the audit lines name
 * their row by it. Read as unknown: a result without it is `undefined`.
 */
export function insertedRowId(result: unknown): number | undefined {
  if (!isRecord(result) || !isRecord(result['meta'])) return undefined;
  const id = result['meta']['last_row_id'];
  return typeof id === 'number' && id > 0 ? id : undefined;
}
