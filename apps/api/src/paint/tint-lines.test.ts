import { describe, expect, it } from 'vitest';
import { carriesByLineNo } from './tint-lines.js';

describe('carriesByLineNo', () => {
  it('pairs copied lines by number and skips a line with no source', () => {
    expect(
      carriesByLineNo(
        [{ id: 'old-1', lineNo: 1 }],
        [
          { id: 'new-1', lineNo: 1, quantity: 2, storeId: 'amp' },
          { id: 'new-2', lineNo: 2, quantity: 1, storeId: 'amp' },
        ],
      ),
    ).toEqual([{ fromLineId: 'old-1', toLineId: 'new-1', quantity: 2, storeId: 'amp' }]);
  });
});
