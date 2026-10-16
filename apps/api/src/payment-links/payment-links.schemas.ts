import {
  LINK_AMOUNT_BASES,
  MAX_LINK_CAP_PAISE,
  MAX_LINK_VALIDITY_MINUTES,
  MIN_LINK_CAP_PAISE,
  MIN_LINK_VALIDITY_MINUTES,
  PAYMENT_LINK_STATUSES,
  RAZORPAY_KEY_ID_PATTERN,
  STAFF_LINK_PURPOSES,
} from '@paint/shared';
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
      .max(MAX_LINK_CAP_PAISE, 'A link asks for at most ₹5,00,000')
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
  .object({ amountPaise: z.number().int().positive().max(MAX_LINK_CAP_PAISE).optional() })
  .strict()
  .default({});
export type LogPayInput = z.infer<typeof logPaySchema>;

/** PUT /payment-links/settings ([PO-41] – [PO-43]). */
export const updateLinkSettingsSchema = z
  .object({
    validityMinutes: z
      .number()
      .int()
      .min(MIN_LINK_VALIDITY_MINUTES, 'A link stays payable for at least 5 minutes')
      .max(MAX_LINK_VALIDITY_MINUTES, 'A link stays payable for at most 30 days'),
    messageValidityMinutes: z
      .number()
      .int()
      .min(MIN_LINK_VALIDITY_MINUTES, 'A link stays payable for at least 5 minutes')
      .max(MAX_LINK_VALIDITY_MINUTES, 'A link stays payable for at most 30 days'),
    capPaise: z
      .number()
      .int()
      .min(MIN_LINK_CAP_PAISE, 'A link asks for at least ₹1')
      .max(MAX_LINK_CAP_PAISE, 'UPI takes at most ₹5,00,000 in one payment'),
    amountBasis: z.enum(LINK_AMOUNT_BASES),
  })
  .strict();
export type UpdateLinkSettingsInput = z.infer<typeof updateLinkSettingsSchema>;

/** PUT /payment-links/gateway-account: the keys from Razorpay's dashboard ([PO-40]). */
export const connectGatewaySchema = z
  .object({
    keyId: z.string().trim().regex(RAZORPAY_KEY_ID_PATTERN, 'Enter a key id like rzp_live_…'),
    keySecret: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{16,64}$/, 'Enter the key secret shown with the key id'),
    webhookSecret: z
      .string()
      .min(8, 'Use a webhook secret of at least 8 characters')
      .max(128, 'Use a webhook secret of at most 128 characters')
      .regex(/^[\x21-\x7e]+$/, 'Use letters, digits and symbols, without spaces'),
  })
  .strict();
export type ConnectGatewayInput = z.infer<typeof connectGatewaySchema>;
