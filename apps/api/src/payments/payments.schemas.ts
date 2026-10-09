import {
  CASH_DENOMINATIONS_PAISE,
  CHEQUE_STATUSES,
  PAYMENT_DIRECTIONS,
  PAYMENT_MODE_KINDS,
  REGISTER_MOVEMENT_KINDS,
  REGISTER_SESSION_STATUSES,
} from '@paint/shared';
import { z } from 'zod';
import { cursorParam, keysetPage, type Keyset } from '../common/keyset.js';

/** A party's ledger, oldest first: by day, then when it was posted, then id. */
export const LEDGER_ORDER: Keyset = { order: 'asc', parts: ['date', 'timestamp', 'uuid'] };
const isoDate = z.iso.date('Use a date like 2026-04-01');
const amount = z.number().int().positive('Enter an amount above zero').max(1_000_000_000_000);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Part of a payment against one bill: a document, or an opening balance or charge. */
export const allocationSchema = z
  .object({
    documentId: z.uuid().optional(),
    partyLedgerId: z.uuid().optional(),
    amountPaise: amount,
  })
  .refine((item) => (item.documentId === undefined) !== (item.partyLedgerId === undefined), {
    message: 'Name either a bill (documentId) or a ledger entry (partyLedgerId)',
    path: ['documentId'],
  });
const allocationList = z.array(allocationSchema).max(100);

/** How the money moved: shared by payments, refunds and the payments of an issue. */
const moneyFields = {
  modeId: z.uuid(),
  amountPaise: amount,
  reference: text(100).optional(),
  chequeDate: isoDate.optional(),
  tenderedPaise: amount.optional(),
  registerSessionId: z.uuid().optional(),
  gatewayReference: text(200).optional(),
};

export const recordPaymentSchema = z.object({
  storeId: z.uuid(),
  partyId: z.uuid(),
  ...moneyFields,
  receivedOn: isoDate.optional(),
  note: text(500).optional(),
  allocations: allocationList.optional(),
});
export type RecordPaymentInput = z.output<typeof recordPaymentSchema>;

export const allocatePaymentSchema = z.object({ allocations: allocationList.optional() });
export type AllocatePaymentInput = z.output<typeof allocatePaymentSchema>;

export const clearChequeSchema = z.object({ clearedOn: isoDate.optional() });
export type ClearChequeInput = z.output<typeof clearChequeSchema>;

export const bounceChequeSchema = z.object({
  bouncedOn: isoDate.optional(),
  reason: text(500),
  chargePaise: amount.optional(),
});
export type BounceChequeInput = z.output<typeof bounceChequeSchema>;

export const refundSchema = z.object({
  modeId: z.uuid(),
  amountPaise: amount,
  paidOn: isoDate.optional(),
  reference: text(100).optional(),
  registerSessionId: z.uuid().optional(),
  note: text(500).optional(),
});
export type RefundInput = z.output<typeof refundSchema>;

/** One payment taken with an issue (the POS). */
export const issuePaymentSchema = z.object(moneyFields);
export type IssuePaymentInput = z.output<typeof issuePaymentSchema>;

export const listPaymentsSchema = z.object({
  storeId: z.uuid().optional(),
  partyId: z.uuid().optional(),
  direction: z.enum(PAYMENT_DIRECTIONS).optional(),
  modeKind: z.enum(PAYMENT_MODE_KINDS).optional(),
  chequeStatus: z.enum(CHEQUE_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Receipt, voucher or reference number. */
  q: z.string().trim().min(1).max(80).optional(),
  ...keysetPage,
});
export type ListPaymentsQuery = z.output<typeof listPaymentsSchema>;

export const createPaymentModeSchema = z.object({
  kind: z.enum(PAYMENT_MODE_KINDS),
  name: text(60),
});
export type CreatePaymentModeInput = z.output<typeof createPaymentModeSchema>;

export const updatePaymentModeSchema = z
  .object({ name: text(60).optional(), isActive: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.isActive !== undefined, {
    message: 'Change the name or whether it is in use',
  });
export type UpdatePaymentModeInput = z.output<typeof updatePaymentModeSchema>;

export const partyLedgerQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Entries per page (round 6c): a busy contractor's account has thousands. */
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** A page by position, for a shared link; a cursor wins over it. */
  offset: z.coerce.number().int().min(0).default(0),
  cursor: cursorParam(LEDGER_ORDER),
});
export type PartyLedgerQuery = z.output<typeof partyLedgerQuerySchema>;

/** `:code` of /registers/:code/open: letters, digits and dashes, e.g. COUNTER1. */
export const registerCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,20}$/, 'Use letters, digits and dashes, at most 20');

export const openRegisterSchema = z.object({
  storeId: z.uuid(),
  openingFloatPaise: z.number().int().min(0).max(100_000_000),
  note: text(300).optional(),
});
export type OpenRegisterInput = z.output<typeof openRegisterSchema>;

export const cashMovementSchema = z.object({
  kind: z.enum(REGISTER_MOVEMENT_KINDS),
  amountPaise: amount,
  reason: text(200),
});
export type CashMovementInput = z.output<typeof cashMovementSchema>;

const DENOMINATION_KEYS = CASH_DENOMINATIONS_PAISE.map(String);

export const closeRegisterSchema = z
  .object({
    denominations: z
      .record(
        z.string().refine((key) => DENOMINATION_KEYS.includes(key), 'Not a note or coin we count'),
        z.number().int().min(0).max(100_000),
      )
      .optional(),
    countedCashPaise: z.number().int().min(0).max(100_000_000_000).optional(),
    note: text(300).optional(),
  })
  .refine((body) => body.denominations !== undefined || body.countedCashPaise !== undefined, {
    message: 'Count the cash: by denomination or as a total',
    path: ['countedCashPaise'],
  });
export type CloseRegisterInput = z.output<typeof closeRegisterSchema>;

export const listRegisterSessionsSchema = z.object({
  storeId: z.uuid().optional(),
  status: z.enum(REGISTER_SESSION_STATUSES).optional(),
  ...keysetPage,
});
export type ListRegisterSessionsQuery = z.output<typeof listRegisterSessionsSchema>;
