import {
  EWAY_BILL_NO_PATTERN,
  MAX_LINE_QUANTITY,
  MAX_SALES_LINES,
  PAYMENT_TERMS,
  PRICE_MODES,
  QUOTATION_STATUSES,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  SALES_NOTE_MAX_LENGTH,
  SALES_ORDER_STATUSES,
  STALE_RESERVATION_DAYS,
  VEHICLE_NO_MAX_LENGTH,
  hasAtMostThreeDecimals,
  isCurrentGstStateCode,
  type BillOrderRequest,
  type CancelOrderLineRequest,
  type CancelSalesOrderRequest,
  type ConfirmSalesOrderRequest,
  type ConvertQuotationRequest,
  type DispatchRequest,
  type GoLiveRequest,
  type QuotationRequest,
  type ReleaseOrderRequest,
  type ReserveOrderRequest,
  type SalesOrderRequest,
} from '@paint/shared';
import { z } from 'zod';
import { keysetPage } from '../common/keyset.js';
import { lineTintSchema } from '../paint/paint.schemas.js';

// The request shapes are the contract's (@paint/shared orders-api); each schema
// below is checked against it with `satisfies`, so the two cannot drift apart.

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.iso.date('Use a date like 2026-04-01');
const paise = z.number().int().min(0).max(1_000_000_000_000);
const reason = z.string().trim().min(REASON_MIN_LENGTH).max(REASON_MAX_LENGTH);
const quantity = z
  .number()
  .positive('Quantity must be more than zero')
  .max(MAX_LINE_QUANTITY)
  .refine(hasAtMostThreeDecimals, 'Use at most 3 decimals');

/** A discount: a percentage in basis points (1000 = 10%) or an amount in paise. */
const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), basisPoints: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal('amount'), paise }),
]);

const shipTo = z.object({
  name: text(160).optional(),
  address: text(300).optional(),
  stateCode: z.string().trim().refine(isCurrentGstStateCode, 'Choose a state'),
});

const saleLine = {
  variantId: z.uuid(),
  quantity,
  unitPricePaise: paise.optional(),
  discount: discount.optional(),
  tint: lineTintSchema.optional(),
};

const saleHeader = {
  storeId: z.uuid(),
  billToPartyId: z.uuid(),
  influencerPartyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  shipTo: shipTo.optional(),
  priceMode: z.enum(PRICE_MODES).optional(),
  billDiscount: discount.optional(),
  note: text(SALES_NOTE_MAX_LENGTH).optional(),
};

export const quotationSchema = z.object({
  ...saleHeader,
  validUntil: isoDate.optional(),
  lines: z.array(z.object(saleLine)).min(1).max(MAX_SALES_LINES),
}) satisfies z.ZodType<QuotationRequest>;
export type QuotationInput = z.output<typeof quotationSchema>;

export const convertQuotationSchema = z.object({
  paymentTerms: z.enum(PAYMENT_TERMS),
  fulfilStoreId: z.uuid().optional(),
  note: text(SALES_NOTE_MAX_LENGTH).optional(),
}) satisfies z.ZodType<ConvertQuotationRequest>;
export type ConvertQuotationInput = z.output<typeof convertQuotationSchema>;

export const salesOrderSchema = z.object({
  ...saleHeader,
  paymentTerms: z.enum(PAYMENT_TERMS),
  lines: z
    .array(z.object({ ...saleLine, fulfilStoreId: z.uuid().optional() }))
    .min(1)
    .max(MAX_SALES_LINES),
}) satisfies z.ZodType<SalesOrderRequest>;
export type SalesOrderInput = z.output<typeof salesOrderSchema>;

export const confirmOrderSchema = z.object({
  creditOverride: z.object({ reason }).optional(),
}) satisfies z.ZodType<ConfirmSalesOrderRequest>;
export type ConfirmOrderInput = z.output<typeof confirmOrderSchema>;

export const cancelOrderSchema = z.object({ reason }) satisfies z.ZodType<CancelSalesOrderRequest>;
export type CancelOrderInput = z.output<typeof cancelOrderSchema>;

export const cancelLineSchema = z.object({
  quantity: quantity.optional(),
  reason,
}) satisfies z.ZodType<CancelOrderLineRequest>;
export type CancelLineInput = z.output<typeof cancelLineSchema>;

export const reserveOrderSchema = z.object({
  lines: z
    .array(z.object({ lineId: z.uuid(), fulfilStoreId: z.uuid().optional() }))
    .min(1)
    .max(MAX_SALES_LINES)
    .optional(),
}) satisfies z.ZodType<ReserveOrderRequest>;
export type ReserveOrderInput = z.output<typeof reserveOrderSchema>;

export const releaseOrderSchema = z.object({
  lineIds: z.array(z.uuid()).min(1).max(MAX_SALES_LINES).optional(),
}) satisfies z.ZodType<ReleaseOrderRequest>;
export type ReleaseOrderInput = z.output<typeof releaseOrderSchema>;

export const billOrderSchema = z.object({
  storeId: z.uuid().optional(),
  lines: z
    .array(z.object({ orderLineId: z.uuid(), quantity }))
    .min(1)
    .max(MAX_SALES_LINES)
    .optional(),
  note: text(SALES_NOTE_MAX_LENGTH).optional(),
}) satisfies z.ZodType<BillOrderRequest>;
export type BillOrderInput = z.output<typeof billOrderSchema>;

export const dispatchSchema = z.object({
  lines: z
    .array(z.object({ invoiceLineId: z.uuid(), quantity }))
    .min(1)
    .max(MAX_SALES_LINES)
    .optional(),
  vehicleNo: z.string().trim().toUpperCase().min(1).max(VEHICLE_NO_MAX_LENGTH).optional(),
  ewayBillNo: z
    .string()
    .trim()
    .regex(EWAY_BILL_NO_PATTERN, 'An e-way bill number is 12 digits')
    .optional(),
  ewayValidUntil: isoDate.optional(),
  note: text(SALES_NOTE_MAX_LENGTH).optional(),
}) satisfies z.ZodType<DispatchRequest>;
export type DispatchInput = z.output<typeof dispatchSchema>;

export const goLiveSchema = z.object({
  liveOn: isoDate.optional(),
  openings: z
    .array(
      z.object({
        partyId: z.uuid(),
        amountPaise: paise,
        overdueSince: isoDate.optional(),
      }),
    )
    .max(10_000)
    .refine(
      (openings) => new Set(openings.map((opening) => opening.partyId)).size === openings.length,
      'Give each party once',
    )
    .optional(),
}) satisfies z.ZodType<GoLiveRequest>;
export type GoLiveInput = z.output<typeof goLiveSchema>;

const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
};

export const listQuotationsSchema = z.object({
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z.enum(QUOTATION_STATUSES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  allVersions: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .default(false),
  ...keysetPage,
});
export type ListQuotationsQuery = z.output<typeof listQuotationsSchema>;

export const listOrdersSchema = z.object({
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  status: z.enum(SALES_ORDER_STATUSES).optional(),
  q: z.string().trim().min(1).max(80).optional(),
  ...keysetPage,
});
export type ListOrdersQuery = z.output<typeof listOrdersSchema>;

export const staleReservationsSchema = z.object({
  storeId: z.uuid().optional(),
  olderThanDays: z.coerce.number().int().min(0).max(3650).default(STALE_RESERVATION_DAYS),
  ...page,
});
export type StaleReservationsQuery = z.output<typeof staleReservationsSchema>;
