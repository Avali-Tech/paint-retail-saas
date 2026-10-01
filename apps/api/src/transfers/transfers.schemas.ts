import { z } from 'zod';

const threeDecimals = (value: number) => Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;
const quantity = z
  .number()
  .min(0)
  .max(1_000_000_000)
  .refine(threeDecimals, 'Use at most 3 decimals');

const uniqueVariants = <T extends { variantId: string }>(
  lines: T[],
  context: z.core.$RefinementCtx<T[]>,
) => {
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (seen.has(line.variantId)) {
      context.addIssue({
        code: 'custom',
        path: [index, 'variantId'],
        message: 'Each product can appear only once',
      });
    }
    seen.add(line.variantId);
  });
};

export const createTransferSchema = z
  .object({
    fromStoreId: z.uuid(),
    toStoreId: z.uuid(),
    note: z.string().trim().min(1).max(500).optional(),
    lines: z
      .array(
        z.object({
          variantId: z.uuid(),
          quantity: quantity.refine((value) => value > 0, 'Quantity must be more than zero'),
        }),
      )
      .min(1)
      .max(200)
      .superRefine(uniqueVariants),
  })
  .refine((body) => body.fromStoreId !== body.toStoreId, {
    path: ['toStoreId'],
    message: 'Choose two different stores',
  });
export type CreateTransferInput = z.output<typeof createTransferSchema>;

/** Quantities for approving or dispatching; omit `lines` to take every line in full. */
export const quantitiesSchema = z.object({
  lines: z
    .array(z.object({ variantId: z.uuid(), quantity }))
    .min(1)
    .max(200)
    .superRefine(uniqueVariants)
    .optional(),
});
export type QuantitiesInput = z.output<typeof quantitiesSchema>;

/** What arrived; omit `lines` when everything dispatched arrived in good condition. */
export const receiveSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
  lines: z
    .array(z.object({ variantId: z.uuid(), received: quantity, damaged: quantity.default(0) }))
    .min(1)
    .max(200)
    .superRefine(uniqueVariants)
    .optional(),
});
export type ReceiveInput = z.output<typeof receiveSchema>;

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'cancelled',
] as const;

export const listTransfersSchema = z.object({
  status: z.enum(TRANSFER_STATUSES).optional(),
  /** Relative to the member's stores: incoming = being sent to them, outgoing = sent from them. */
  direction: z.enum(['incoming', 'outgoing']).optional(),
  storeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTransfersQuery = z.output<typeof listTransfersSchema>;
