import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINK_CAP_PAISE,
  MAX_REFUND_ATTEMPTS,
  PAYMENT_LINK_MANAGE_PERMISSION,
  PAYMENT_LINK_READ_PERMISSION,
  PAYMENT_LINK_SETTINGS_PERMISSION,
  PAYMENT_LINK_STATUSES,
  RAZORPAY_KEY_ID_PATTERN,
  allocateLinkPayment,
  isPermission,
  linkRefundOf,
  linkStatusAt,
  nextLinkState,
  planPaymentLink,
  refundRetryMinutes,
  type LinkEventKind,
  type LinkTarget,
  type PaymentLinkStatus,
} from '../index.js';

const target = (
  documentId: string | null,
  outstandingPaise: number,
  dueOn: string | null = null,
): LinkTarget => ({
  documentId,
  partyLedgerId: documentId === null ? `ledger-${String(outstandingPaise)}` : null,
  number: documentId,
  dueOn,
  outstandingPaise,
});

// Oldest first, as openTargets gives them: an opening balance, two overdue bills, one not due.
const OPEN = [
  target(null, 5_000),
  target('INV-1', 10_000, '2026-10-01'),
  target('INV-2', 20_000, '2026-10-10'),
  target('INV-3', 30_000, '2026-10-20'),
];
const TODAY = '2026-10-16';

describe('planPaymentLink', () => {
  it('asks for an invoice’s outstanding, or less', () => {
    expect(
      planPaymentLink({
        purpose: 'invoice',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        documentIds: ['INV-2'],
      }),
    ).toEqual({ ok: true, targets: [OPEN[2]], amountPaise: 20_000, duePaise: 20_000 });
    expect(
      planPaymentLink({
        purpose: 'invoice',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        documentIds: ['INV-2'],
        amountPaise: 5_000,
      }),
    ).toMatchObject({ ok: true, amountPaise: 5_000, duePaise: 20_000 });
  });

  it('asks for the bills past their due date, oldest first, or everything owed', () => {
    expect(
      planPaymentLink({ purpose: 'overdue', open: OPEN, advancePaise: 0, today: TODAY }),
    ).toEqual({ ok: true, targets: [OPEN[1], OPEN[2]], amountPaise: 30_000, duePaise: 30_000 });
    expect(
      planPaymentLink({ purpose: 'outstanding', open: OPEN, advancePaise: 0, today: TODAY }),
    ).toMatchObject({ ok: true, targets: OPEN, amountPaise: 65_000 });
    // A bill due today is not overdue yet.
    expect(
      planPaymentLink({
        purpose: 'overdue',
        open: [target('INV-9', 100, TODAY)],
        advancePaise: 0,
        today: TODAY,
      }),
    ).toEqual({ ok: false, problem: 'nothing_due' });
  });

  it('asks for the bills a reminder named', () => {
    expect(
      planPaymentLink({
        purpose: 'bills',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        documentIds: ['INV-3', 'INV-1'],
      }),
    ).toMatchObject({ ok: true, targets: [OPEN[1], OPEN[3]], amountPaise: 40_000 });
  });

  it('never asks for more than the balance net of the advance', () => {
    expect(
      planPaymentLink({ purpose: 'outstanding', open: OPEN, advancePaise: 15_000, today: TODAY }),
    ).toMatchObject({ ok: true, amountPaise: 50_000, duePaise: 50_000 });
    expect(
      planPaymentLink({ purpose: 'overdue', open: OPEN, advancePaise: 60_000, today: TODAY }),
    ).toMatchObject({ ok: true, amountPaise: 5_000 });
    expect(
      planPaymentLink({
        purpose: 'invoice',
        open: OPEN,
        advancePaise: 65_000,
        today: TODAY,
        documentIds: ['INV-1'],
      }),
    ).toEqual({ ok: false, problem: 'covered_by_advance' });
  });

  it('refuses a paid invoice, an empty account, a custom amount above what is owed and too much', () => {
    expect(
      planPaymentLink({
        purpose: 'invoice',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        documentIds: ['INV-PAID'],
      }),
    ).toEqual({ ok: false, problem: 'not_open' });
    expect(planPaymentLink({ purpose: 'bills', open: [], advancePaise: 0, today: TODAY })).toEqual({
      ok: false,
      problem: 'not_open',
    });
    expect(
      planPaymentLink({ purpose: 'outstanding', open: [], advancePaise: 0, today: TODAY }),
    ).toEqual({ ok: false, problem: 'nothing_due' });
    expect(
      planPaymentLink({
        purpose: 'outstanding',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        amountPaise: 65_001,
      }),
    ).toEqual({ ok: false, problem: 'over_due' });
    expect(
      planPaymentLink({
        purpose: 'advance',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        amountPaise: DEFAULT_LINK_CAP_PAISE + 1,
      }),
    ).toEqual({ ok: false, problem: 'over_limit' });
  });

  it('asks for the bills’ full outstanding with the full basis, whatever the advance ([PO-43])', () => {
    expect(
      planPaymentLink({
        purpose: 'outstanding',
        open: OPEN,
        advancePaise: 15_000,
        today: TODAY,
        basis: 'full',
      }),
    ).toMatchObject({ ok: true, amountPaise: 65_000, duePaise: 65_000 });
    expect(
      planPaymentLink({
        purpose: 'invoice',
        open: OPEN,
        advancePaise: 65_000,
        today: TODAY,
        documentIds: ['INV-1'],
        basis: 'full',
      }),
    ).toMatchObject({ ok: true, amountPaise: 10_000 });
  });

  it('refuses a link above the business’s cap, asked or worked out ([PO-42])', () => {
    expect(
      planPaymentLink({
        purpose: 'outstanding',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        capPaise: 60_000,
      }),
    ).toEqual({ ok: false, problem: 'over_limit' });
    expect(
      planPaymentLink({
        purpose: 'outstanding',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        capPaise: 60_000,
        amountPaise: 60_000,
      }),
    ).toMatchObject({ ok: true, amountPaise: 60_000, duePaise: 65_000 });
    expect(
      planPaymentLink({
        purpose: 'advance',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        capPaise: 1_000,
        amountPaise: 1_001,
      }),
    ).toEqual({ ok: false, problem: 'over_limit' });
  });

  it('takes any amount as an advance, for no bill, and needs one', () => {
    expect(
      planPaymentLink({
        purpose: 'advance',
        open: OPEN,
        advancePaise: 0,
        today: TODAY,
        amountPaise: 1_00_000_00,
      }),
    ).toEqual({ ok: true, targets: [], amountPaise: 1_00_000_00, duePaise: 1_00_000_00 });
    expect(
      planPaymentLink({ purpose: 'advance', open: OPEN, advancePaise: 0, today: TODAY }),
    ).toEqual({ ok: false, problem: 'amount_required' });
  });
});

describe('allocateLinkPayment', () => {
  it('pays the documents oldest first, part of the last, nothing as an advance', () => {
    expect(allocateLinkPayment(OPEN, 20_000)).toEqual({
      allocations: [
        { documentId: null, partyLedgerId: 'ledger-5000', amountPaise: 5_000 },
        { documentId: 'INV-1', partyLedgerId: null, amountPaise: 10_000 },
        { documentId: 'INV-2', partyLedgerId: null, amountPaise: 5_000 },
      ],
      advancePaise: 0,
    });
  });

  it('keeps an overpayment, or money for bills already paid, as an advance', () => {
    expect(allocateLinkPayment([target('INV-1', 10_000)], 12_500)).toEqual({
      allocations: [{ documentId: 'INV-1', partyLedgerId: null, amountPaise: 10_000 }],
      advancePaise: 2_500,
    });
    expect(allocateLinkPayment([target('INV-1', 0)], 12_500)).toEqual({
      allocations: [],
      advancePaise: 12_500,
    });
    expect(allocateLinkPayment([], 700)).toEqual({ allocations: [], advancePaise: 700 });
  });
});

describe('nextLinkState', () => {
  const link = (status: PaymentLinkStatus, paidPaise = 0) => ({
    status,
    amountPaise: 10_000,
    paidPaise,
  });

  it('counts every payment; the link is paid once they cover it', () => {
    expect(nextLinkState(link('created'), 'paid', 4_000)).toEqual({
      status: 'created',
      paidPaise: 4_000,
    });
    expect(nextLinkState(link('created', 4_000), 'paid', 6_000)).toEqual({
      status: 'paid',
      paidPaise: 10_000,
    });
    expect(nextLinkState(link('paid', 10_000), 'paid', 500)).toEqual({
      status: 'paid',
      paidPaise: 10_500,
    });
  });

  it('records money after expiry or cancellation, and pays the link when it covers it', () => {
    expect(nextLinkState(link('expired'), 'paid', 10_000).status).toBe('paid');
    expect(nextLinkState(link('cancelled'), 'paid', 10_000).status).toBe('paid');
    expect(nextLinkState(link('cancelled'), 'paid', 1_000)).toEqual({
      status: 'cancelled',
      paidPaise: 1_000,
    });
  });

  it('ends only an open link, so the order of events never matters', () => {
    const events: LinkEventKind[] = ['expired', 'cancelled'];
    for (const event of events) {
      expect(nextLinkState(link('created'), event).status).toBe(event);
      expect(nextLinkState(link('paid', 10_000), event)).toEqual({
        status: 'paid',
        paidPaise: 10_000,
      });
    }
    expect(nextLinkState(link('expired'), 'cancelled').status).toBe('expired');
    // paid then expired, or expired then paid: the same end.
    const then = (first: ReturnType<typeof nextLinkState>) => ({ amountPaise: 10_000, ...first });
    const a = nextLinkState(then(nextLinkState(link('created'), 'paid', 10_000)), 'expired');
    const b = nextLinkState(then(nextLinkState(link('created'), 'expired')), 'paid', 10_000);
    expect(a).toEqual(b);
  });

  it('only ever moves to a status the database allows', () => {
    for (const status of PAYMENT_LINK_STATUSES) {
      for (const event of ['paid', 'expired', 'cancelled'] as const) {
        const next = nextLinkState(link(status), event, 10_000).status;
        const allowed =
          next === status ||
          (status === 'created' && next !== 'created') ||
          (status !== 'paid' && next === 'paid');
        expect(allowed, `${status} + ${event} → ${next}`).toBe(true);
      }
    }
  });
});

describe('linkStatusAt', () => {
  it('reads an open link past its expiry as expired, and leaves the others', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    expect(linkStatusAt('created', '2026-10-16T10:00:00Z', now)).toBe('expired');
    expect(linkStatusAt('created', '2026-10-16T10:00:01Z', now)).toBe('created');
    expect(linkStatusAt('paid', '2026-10-01T00:00:00Z', now)).toBe('paid');
  });
});

describe('linkRefundOf', () => {
  it('sends back what the bills no longer owed: all of it when they were settled', () => {
    expect(linkRefundOf({ purpose: 'invoice', amountPaise: 10_000, advancePaise: 10_000 })).toEqual(
      { amountPaise: 10_000, reason: 'settled' },
    );
    expect(linkRefundOf({ purpose: 'bills', amountPaise: 12_500, advancePaise: 2_500 })).toEqual({
      amountPaise: 2_500,
      reason: 'overpaid',
    });
  });

  it('keeps an advance link’s money, and refunds nothing when the bills took it all', () => {
    expect(
      linkRefundOf({ purpose: 'advance', amountPaise: 5_000, advancePaise: 5_000 }),
    ).toBeNull();
    expect(
      linkRefundOf({ purpose: 'outstanding', amountPaise: 5_000, advancePaise: 0 }),
    ).toBeNull();
  });
});

describe('refundRetryMinutes', () => {
  it('tries again sooner at first, then up to half a day apart, then gives up', () => {
    const delays = Array.from({ length: MAX_REFUND_ATTEMPTS + 1 }, (_, attempts) =>
      refundRetryMinutes(attempts),
    );
    expect(delays).toEqual([null, 1, 5, 30, 120, 720, null]);
  });
});

describe('Razorpay key ids', () => {
  it('are test or live keys', () => {
    expect(RAZORPAY_KEY_ID_PATTERN.test('rzp_test_1DP5mmOlF5G5ag')).toBe(true);
    expect(RAZORPAY_KEY_ID_PATTERN.test('rzp_live_ILgsfZCZoFIKMb')).toBe(true);
    expect(RAZORPAY_KEY_ID_PATTERN.test('rzp_prod_ILgsfZCZoFIKMb')).toBe(false);
    expect(RAZORPAY_KEY_ID_PATTERN.test('rzp_live_x')).toBe(false);
  });
});

describe('permissions', () => {
  it('are known permissions', () => {
    expect(isPermission(PAYMENT_LINK_MANAGE_PERMISSION)).toBe(true);
    expect(isPermission(PAYMENT_LINK_READ_PERMISSION)).toBe(true);
    expect(isPermission(PAYMENT_LINK_SETTINGS_PERMISSION)).toBe(true);
  });
});
