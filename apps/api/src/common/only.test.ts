import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { only } from './only.js';

describe('only', () => {
  it('returns the row', () => {
    expect(only([{ id: 1 }], 'Thing')).toEqual({ id: 1 });
  });

  it('answers 404 when there is none', () => {
    expect(() => only([], 'Business')).toThrow(new NotFoundException('Business not found'));
  });
});
