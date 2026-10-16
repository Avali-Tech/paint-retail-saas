import { BILLING_INTERVALS, PAID_PLAN_KEYS, SUBSCRIPTION_PAYMENT_MODES } from '@paint/shared';
import { z } from 'zod';

export const changePlanSchema = z.object({
  plan: z.enum(PAID_PLAN_KEYS),
  interval: z.enum(BILLING_INTERVALS),
});
export type ChangePlanInput = z.output<typeof changePlanSchema>;

/** An operator records money that arrived for one of our manual invoices. */
export const recordPaymentSchema = z.object({
  amountPaise: z.number().int().min(1).max(100_000_000_00),
  paidOn: z.iso.date('Use a date like 2026-04-01'),
  mode: z.enum(SUBSCRIPTION_PAYMENT_MODES),
  /** The bank's UTR, the UPI reference or the cheque number. */
  reference: z.string().trim().min(1).max(100),
});
export type RecordPaymentInput = z.output<typeof recordPaymentSchema>;

export const extendTrialSchema = z.object({ days: z.number().int().min(1).max(90) });
export type ExtendTrialInput = z.output<typeof extendTrialSchema>;
