import { schema } from '@paint/db';
import { z } from 'zod';

const reason = z.string().trim().min(3).max(1000);
const isoDate = z.iso.date();

export const createApprovalSchema = z.union([
  z.strictObject({ salesOrderId: z.uuid(), reason }),
  z.strictObject({
    invoiceId: z.uuid(),
    /** What stays unpaid at issue: the screen knows it from its preview. */
    amountPaise: z.number().int().min(1).max(100_000_000_000_00),
    reason,
  }),
  z.strictObject({ kind: z.literal('release'), partyId: z.uuid(), reason }),
]);
export type CreateApprovalInput = z.output<typeof createApprovalSchema>;

export const approveSchema = z.object({
  reason: reason.optional(),
  waiveOverdueUntil: isoDate.optional(),
});
export type ApproveInput = z.output<typeof approveSchema>;

export const rejectSchema = z.object({ reason });

export const releaseSchema = z.object({
  reason: reason.optional(),
  waiveOverdueUntil: isoDate.optional(),
});
export type ReleaseInput = z.output<typeof releaseSchema>;

export const listApprovalsSchema = z.object({
  status: z.enum(schema.creditApprovalStatus.enumValues).optional(),
  kind: z.enum(schema.creditApprovalKind.enumValues).optional(),
  partyId: z.uuid().optional(),
  /** Only those the member may decide now. */
  mine: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListApprovalsQuery = z.output<typeof listApprovalsSchema>;
