import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const pipe = new ZodValidationPipe(
  z.object({ name: z.string().trim().min(2), quantity: z.coerce.number().int().positive() }),
);

describe('ZodValidationPipe', () => {
  it('returns the parsed, converted value', () => {
    expect(pipe.transform({ name: '  Apex ', quantity: '3' })).toEqual({
      name: 'Apex',
      quantity: 3,
    });
  });

  it('answers 400 listing every invalid field', () => {
    const error = (() => {
      try {
        pipe.transform({ name: 'A', quantity: -1, extra: true });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message: string;
      issues: { path: string; message: string }[];
    };
    expect(response.message).toBe('Invalid request');
    expect(response.issues.map((issue) => issue.path)).toEqual(['name', 'quantity']);
  });

  it('rejects a missing body', () => {
    expect(() => pipe.transform(undefined)).toThrow(BadRequestException);
  });
});
