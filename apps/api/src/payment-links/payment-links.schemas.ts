import { MAX_PAYMENT_LINK_PAISE, PAYMENT_LINK_STATUSES, STAFF_LINK_PURPOSES } from '@paint/shared';
import { z } from 'zod';

/** POST /payment-links. */
export const createPaymentLinkSchema = z
  .object({
    partyId: z.uuid(),
    purpose: z.enum(STAFF_LINK_PURPOSES),
    invoiceId: z.uuid().optional(),
    amountPaise: z
      .number()
      .int()
      .positive('Enter an amount above zero')
      .max(MAX_PAYMENT_LINK_PAISE, 'A link asks for at most ₹10,00,000')
      .optional(),
    storeId: z.uuid().optional(),
    send: z.literal('whatsapp').optional(),
  })
  .strict()
  .refine((body) => (body.purpose === 'invoice') === (body.invoiceId !== undefined), {
    message: 'An invoice link names its invoice; other links name none',
    path: ['invoiceId'],
  })
  .refine((body) => body.purpose !== 'advance' || body.amountPaise !== undefined, {
    message: 'Enter the amount of the advance',
    path: ['amountPaise'],
  });
export type CreatePaymentLinkInput = z.infer<typeof createPaymentLinkSchema>;

/** GET /payment-links. */
export const listPaymentLinksSchema = z.object({
  partyId: z.uuid().optional(),
  invoiceId: z.uuid().optional(),
  storeId: z.uuid().optional(),
  status: z.enum(PAYMENT_LINK_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type ListPaymentLinksQuery = z.infer<typeof listPaymentLinksSchema>;

/** POST /public/payment-links/log/:reference/pay. */
export const logPaySchema = z
  .object({ amountPaise: z.number().int().positive().max(MAX_PAYMENT_LINK_PAISE).optional() })
  .strict()
  .default({});
export type LogPayInput = z.infer<typeof logPaySchema>;
