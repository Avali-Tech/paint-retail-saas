import { MISTINT_STATUSES } from '@paint/shared';
import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);

export const recordMistintSchema = z.object({
  storeId: z.uuid(),
  variantId: z.uuid(),
  quantity: z
    .number()
    .positive('Quantity must be more than zero')
    .max(1_000)
    .refine((value) => Number.isInteger(value * 1000), 'Use at most 3 decimals'),
  shadeCode: text(40),
  shadeName: text(80).optional(),
  intendedShade: text(40).optional(),
  reason: z.string().trim().min(2, 'Say what went wrong').max(300),
});
export type RecordMistintInput = z.output<typeof recordMistintSchema>;

export const listMistintsSchema = z.object({
  status: z.enum(MISTINT_STATUSES).optional(),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListMistintsQuery = z.output<typeof listMistintsSchema>;

export const writeOffMistintSchema = z.object({
  note: z.string().trim().min(2, 'Say why it is written off').max(300),
});
export type WriteOffMistintInput = z.output<typeof writeOffMistintSchema>;
