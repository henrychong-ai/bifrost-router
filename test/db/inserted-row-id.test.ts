import { describe, expect, it } from 'vitest';
import { insertedRowId } from '../../src/db/inserted-row-id';

/** The one reader of a D1 insert's row id (v1.47.0), for the audit and R2 event lines. */
describe('insertedRowId', () => {
  it('reads a positive meta.last_row_id', () => {
    expect(insertedRowId({ meta: { last_row_id: 42 } })).toBe(42);
  });

  it.each([
    ['no result', undefined],
    ['no meta', {}],
    ['a meta that is not an object', { meta: 'x' }],
    ['a zero id', { meta: { last_row_id: 0 } }],
    ['a text id', { meta: { last_row_id: '42' } }],
  ])('is undefined for %s', (_label, result) => {
    expect(insertedRowId(result)).toBeUndefined();
  });
});
