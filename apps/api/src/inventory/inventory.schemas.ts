import { z } from 'zod';

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;

export const MOVEMENT_KINDS = ['opening', 'adjustment', 'damage'] as const;

const line = z.object({
  variantId: z.uuid(),
  /** Opening and damage: a positive amount. Adjustment: + to add, - to remove. */
  quantity: z
    .number()
    .refine((value) => value !== 0, 'Quantity cannot be zero')
    .refine((value) => Math.abs(value) <= 1_000_000_000, 'Quantity is too large')
    .refine(threeDecimals, 'Use at most 3 decimals'),
  /** Cost per unit in paise, for stock coming in. */
  unitCostPaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export const createMovementSchema = z
  .object({
    storeId: z.uuid(),
    type: z.enum(MOVEMENT_KINDS),
    note: z.string().trim().min(3).max(500).optional(),
    lines: z.array(line).min(1).max(200),
  })
  .superRefine((body, context) => {
    if (body.type !== 'opening' && body.note === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Say why stock is being adjusted or written off',
      });
    }
    const seen = new Set<string>();
    body.lines.forEach((entry, index) => {
      if (seen.has(entry.variantId)) {
        context.addIssue({
          code: 'custom',
          path: ['lines', index, 'variantId'],
          message: 'Each product can appear only once',
        });
      }
      seen.add(entry.variantId);
      if (body.type !== 'adjustment' && entry.quantity < 0) {
        context.addIssue({
          code: 'custom',
          path: ['lines', index, 'quantity'],
          message: 'Enter a positive quantity',
        });
      }
      const incoming = body.type !== 'damage' && entry.quantity > 0;
      if (entry.unitCostPaise !== undefined && !incoming) {
        context.addIssue({
          code: 'custom',
          path: ['lines', index, 'unitCostPaise'],
          message: 'A cost applies only to stock coming in',
        });
      }
    });
  });
export type CreateMovementInput = z.output<typeof createMovementSchema>;

const paging = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export const listStockSchema = z.object({
  storeId: z.uuid().optional(),
  productId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  inStockOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ...paging,
});
export type ListStockQuery = z.output<typeof listStockSchema>;

export const availabilitySchema = z.object({ variantId: z.uuid() });

export const ledgerSchema = z.object({
  storeId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  ...paging,
});
export type LedgerQuery = z.output<typeof ledgerSchema>;
