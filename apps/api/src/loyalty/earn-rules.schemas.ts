import { schema } from '@paint/db';
import { z } from 'zod';

const isoDate = z.iso.date('Use a date like 2026-04-01');

/** A painter points earn rule (P2-M36): per ₹ of taxable value or per litre. */
export const earnRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    basis: z.enum(schema.loyaltyEarnBasis.enumValues),
    points: z.number().int().min(1).max(1_000),
    /** Value basis: ₹1 to ₹1 lakh. */
    perPaise: z.number().int().min(100).max(10_000_000).nullable(),
    /** Litre basis: 100 ml to 1,000 litres. */
    perMillilitres: z.number().int().min(100).max(1_000_000).nullable(),
    brandId: z.uuid().nullable(),
    /** ×0.1 to ×10. */
    multiplierBps: z.number().int().min(1_000).max(100_000),
    validFrom: isoDate.nullable(),
    validUntil: isoDate.nullable(),
    isActive: z.boolean(),
  })
  .superRefine((rule, context) => {
    const [needed, unwanted] =
      rule.basis === 'value'
        ? (['perPaise', 'perMillilitres'] as const)
        : (['perMillilitres', 'perPaise'] as const);
    if (rule[needed] === null) {
      context.addIssue({ code: 'custom', path: [needed], message: 'Required for this basis' });
    }
    if (rule[unwanted] !== null) {
      context.addIssue({ code: 'custom', path: [unwanted], message: 'Not used by this basis' });
    }
    if (rule.validFrom !== null && rule.validUntil !== null && rule.validFrom > rule.validUntil) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Ends before it starts',
      });
    }
  });
export type EarnRuleBody = z.output<typeof earnRuleSchema>;
