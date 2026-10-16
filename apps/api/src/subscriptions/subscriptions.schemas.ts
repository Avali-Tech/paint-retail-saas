import { BILLING_INTERVALS, PAID_PLAN_KEYS } from '@paint/shared';
import { z } from 'zod';

export const changePlanSchema = z.object({
  plan: z.enum(PAID_PLAN_KEYS),
  interval: z.enum(BILLING_INTERVALS),
});
export type ChangePlanInput = z.output<typeof changePlanSchema>;

export const extendTrialSchema = z.object({ days: z.number().int().min(1).max(90) });
export type ExtendTrialInput = z.output<typeof extendTrialSchema>;
