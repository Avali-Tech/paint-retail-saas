import {
  AATO_BANDS,
  INVOICE_TERMS_MAX,
  INVOICE_TERM_MAX_LENGTH,
  PRICE_MODES,
  STOCK_POST_ON,
  TAX_DOCUMENT_KINDS,
  TAX_DOCUMENT_STATUSES,
  isCurrentGstStateCode,
  isValidBankAccount,
  isValidGstin,
  isValidIfsc,
  isValidSeriesPrefix,
  isValidUpiId,
  type DraftInvoiceLineRequest,
} from '@paint/shared';
import { z } from 'zod';
import { keysetPage } from '../common/keyset.js';
import { lineTintSchema } from '../paint/paint.schemas.js';
import { issuePaymentSchema } from '../payments/payments.schemas.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date('Use a date like 2026-04-01');
const stateCode = z.string().trim().refine(isCurrentGstStateCode, 'Choose a state');
const paise = z.number().int().min(0).max(1_000_000_000_000);
export const threeDecimals = (value: number) =>
  Math.abs(Math.round(value * 1000) - value * 1000) < 1e-6;

/** A discount: a percentage in basis points (1000 = 10%) or an amount in paise. */
const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), basisPoints: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal('amount'), paise }),
]);
export type DiscountInput = z.output<typeof discount>;

/** A draft invoice or bill of supply (also a held bill): no number, no stock, no ledger yet. */
export const draftInvoiceSchema = z.object({
  storeId: z.uuid(),
  /** The bill-to party; walk-in sales leave it out. */
  partyId: z.uuid().optional(),
  /** Details typed on the bill; each one overrides the party's. */
  buyer: z
    .object({
      name: text(160).optional(),
      gstin: z
        .string()
        .trim()
        .toUpperCase()
        .refine(isValidGstin, 'Enter a valid GSTIN (check for typos)')
        .optional(),
      address: text(300).optional(),
      stateCode: stateCode.optional(),
    })
    .default({}),
  /** Set when the goods are delivered: its state is then the place of supply for B2C. */
  shipTo: z
    .object({ name: text(160).optional(), address: text(300).optional(), stateCode })
    .optional(),
  /** Defaults to the business's sales setting. */
  priceMode: z.enum(PRICE_MODES).optional(),
  billDiscount: discount.optional(),
  influencerPartyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  dueOn: isoDate.optional(),
  note: text(500).optional(),
  lines: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z
          .number()
          .positive('Quantity must be more than zero')
          .max(1_000_000)
          .refine(threeDecimals, 'Use at most 3 decimals'),
        /** Defaults to the variant's selling price. */
        unitPricePaise: paise.optional(),
        discount: discount.optional(),
        /** The shade it is tinted to (round 5a), written with the line. */
        tint: lineTintSchema.optional(),
      }) satisfies z.ZodType<DraftInvoiceLineRequest>,
    )
    .min(1)
    .max(200),
});
export type DraftInvoiceInput = z.output<typeof draftInvoiceSchema>;

export const issueInvoiceSchema = z.object({
  /** The IRN from the government portal, when the GSTIN must e-invoice (spec §2.10). */
  einvoice: z
    .object({
      irn: z
        .string()
        .trim()
        .regex(/^[0-9a-f]{64}$/i, 'An IRN is 64 hexadecimal characters'),
      ackNo: z
        .string()
        .trim()
        .regex(/^[0-9]{1,20}$/, 'Enter the acknowledgement number'),
      ackAt: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .optional(),
    })
    .optional(),
  /** Taken with the issue, in the same transaction (the POS; spec §4.4). */
  payments: z.array(issuePaymentSchema).max(10).optional(),
  /** Use the customer's unallocated payments (oldest first) before the new ones. */
  allocateAdvances: z.boolean().default(false),
  /**
   * Issue on credit past the rules with the member's own approval (MVP 3 spec
   * §4.3), recorded as a credit approval; refused when they may not give it.
   */
  creditOverride: z.object({ reason: z.string().trim().min(3).max(1000) }).optional(),
});
export type IssueInvoiceInput = z.output<typeof issueInvoiceSchema>;

/** GET /invoices/:id/credit-check: what would stay unpaid at issue. */
export const invoiceCreditCheckSchema = z.object({
  unpaidPaise: z.coerce.number().int().min(0).max(100_000_000_000_00),
});

export const cancelInvoiceSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type CancelInvoiceInput = z.output<typeof cancelInvoiceSchema>;

export const listInvoicesSchema = z.object({
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  status: z.enum(TAX_DOCUMENT_STATUSES).optional(),
  /** Kinds, comma-separated, e.g. "invoice,bill_of_supply" (every kind when left out). */
  kinds: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(TAX_DOCUMENT_KINDS)))
    .optional(),
  /** Issue dates, India time, both inclusive. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Number or buyer name. */
  q: z.string().trim().min(1).max(80).optional(),
  ...keysetPage,
});
export type ListInvoicesQuery = z.output<typeof listInvoicesSchema>;

/** `Idempotency-Key` header: any client-chosen string, e.g. a UUID per bill. */
export const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();

/** A machine unit in ml: more than 0, at most 100, 4 decimals as stored. */
const tintUnitMl = z
  .number()
  .positive()
  .max(100)
  .refine((value) => Math.abs(Math.round(value * 10_000) - value * 10_000) < 1e-6, {
    message: 'Use at most 4 decimals',
  });

export const salesSettingsSchema = z.object({
  stockPostOn: z.enum(STOCK_POST_ON).optional(),
  walkInPartyId: z.uuid().nullable().optional(),
  quoteValidityDays: z.number().int().min(1).max(365).optional(),
  partialMinAdvancePct: z.number().int().min(0).max(100).optional(),
  defaultPriceMode: z.enum(PRICE_MODES).optional(),
  billingLiveOn: isoDate.nullable().optional(),
  cashNeedsRegister: z.boolean().optional(),
  registerVarianceAlertPaise: z.number().int().min(0).max(100_000_000).optional(),
  /** ml in one shot / one Y of the tinting machine (round 8a); null clears it. */
  tintShotMl: tintUnitMl.nullable().optional(),
  tintYMl: tintUnitMl.nullable().optional(),
  /** Printed on the A4 invoice; null removes them. */
  invoiceBank: z
    .object({
      bankName: text(120),
      accountName: text(120),
      accountNumber: z
        .string()
        .trim()
        .refine(isValidBankAccount, 'Use the account number: 9 to 18 digits'),
      ifsc: z.string().trim().toUpperCase().refine(isValidIfsc, 'Use an IFSC like SBIN0020345'),
      upiId: z
        .string()
        .trim()
        .refine(isValidUpiId, 'Use a UPI ID like shop@bank')
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  invoiceTerms: z.array(text(INVOICE_TERM_MAX_LENGTH)).max(INVOICE_TERMS_MAX).optional(),
});
export type SalesSettingsInput = z.output<typeof salesSettingsSchema>;

export const createSeriesSchema = z
  .object({
    storeId: z.uuid(),
    kind: z.enum(TAX_DOCUMENT_KINDS),
    prefix: z.string().trim().toUpperCase(),
    digits: z.number().int().min(3).max(9),
  })
  .refine((body) => isValidSeriesPrefix(body.prefix, body.digits), {
    path: ['prefix'],
    message: 'Use letters and digits only, at most 16 characters with the year and number',
  });
export type CreateSeriesInput = z.output<typeof createSeriesSchema>;

export const updateSeriesSchema = z.object({ isActive: z.boolean() });
export type UpdateSeriesInput = z.output<typeof updateSeriesSchema>;

export const listSeriesSchema = z.object({ storeId: z.uuid().optional() });
export type ListSeriesQuery = z.output<typeof listSeriesSchema>;

export const gstinProfileSchema = z.object({
  aatoBand: z.enum(AATO_BANDS),
  einvoiceRequiredFrom: isoDate.nullable(),
  ewayThresholdPaise: z.number().int().positive().max(100_000_000_00),
});
export type GstinProfileInput = z.output<typeof gstinProfileSchema>;

/** The `:gstin` of a profile's URL. */
export const gstinParamSchema = z.string().toUpperCase().refine(isValidGstin, 'Not a valid GSTIN');
