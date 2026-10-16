import { describe, expect, it } from 'vitest';
import {
  planReceivables,
  type ReceivablesInput,
  type ReceivablesPlan,
} from './bulk-receivables.js';
import { Random } from './random.js';

const NOW = new Date('2026-10-16T06:30:00Z');

const input: ReceivablesInput = {
  organizationId: 'org',
  stores: [
    { id: 'store-1', memberId: 'manager-1' },
    { id: 'store-2', memberId: 'manager-2' },
  ],
  customers: Array.from({ length: 400 }, (_, index) => ({
    id: `party-${String(index)}`,
    name: `Customer ${String(index)}`,
    store: index % 7 === 0 ? null : index % 2,
    projectIds: index % 3 === 0 ? [`project-${String(index)}`] : [],
  })),
  modes: [
    { id: 'bank', kind: 'bank_transfer' },
    { id: 'upi', kind: 'upi' },
  ],
  liveDaysAgo: 60,
  now: NOW,
};

const plan = planReceivables(new Random(7), input, {
  creditCustomers: 300,
  invoicesPerCustomer: 6,
});

const byParty = <T extends { partyId?: unknown }>(rows: readonly T[], party: string) =>
  rows.filter((row) => row.partyId === party);
const sum = (rows: readonly { amountPaise?: unknown }[]) =>
  rows.reduce((total, row) => total + Number(row.amountPaise), 0);

describe('planReceivables', () => {
  it('gives credit to as many customers as asked, in order', () => {
    expect(plan.creditProfiles).toHaveLength(300);
    expect(plan.creditProfiles.map((profile) => profile.partyId)).toEqual(
      input.customers.slice(0, 300).map((customer) => customer.id),
    );
  });

  it('keeps every balance the sum of its ledger, and the advance what is not allocated', () => {
    for (const balance of plan.balances) {
      const party = balance.partyId;
      expect({ party, balance: sum(byParty(plan.ledger, party)) }).toEqual({
        party,
        balance: balance.balancePaise,
      });
      const paid = sum(byParty(plan.payments, party));
      const allocated = sum(byParty(plan.allocations, party));
      expect({ party, advance: paid - allocated }).toEqual({
        party,
        advance: balance.advancePaise,
      });
    }
  });

  it('never allocates more than a bill, an opening balance or a payment holds', () => {
    const totals = new Map<string, number>([
      ...plan.invoices.map((invoice) => [String(invoice.id), Number(invoice.totalPaise)] as const),
      ...plan.payments.map((payment) => [String(payment.id), payment.amountPaise] as const),
      ...plan.ledger
        .filter((entry) => entry.entryType === 'opening')
        .map((entry) => [String(entry.id), entry.amountPaise] as const),
    ]);
    const used = new Map<string, number>();
    for (const allocation of plan.allocations) {
      expect(allocation.amountPaise).toBeGreaterThan(0);
      for (const end of [allocation.paymentId, allocation.documentId ?? allocation.partyLedgerId]) {
        used.set(String(end), (used.get(String(end)) ?? 0) + allocation.amountPaise);
      }
    }
    for (const [id, amount] of used) expect(amount).toBeLessThanOrEqual(Number(totals.get(id)));
  });

  it('writes one ledger entry per bill and payment, with GST that adds up', () => {
    const entries = new Set(plan.ledger.map((entry) => String(entry.referenceId)));
    for (const invoice of plan.invoices) {
      expect(entries.has(String(invoice.id))).toBe(true);
      expect(
        Number(invoice.taxablePaise) + Number(invoice.cgstPaise) + Number(invoice.sgstPaise),
      ).toBe(invoice.totalPaise);
      expect(invoice.cgstPaise).toBe(invoice.sgstPaise);
      expect(String(invoice.dueOn) >= '2026-06-01').toBe(true);
    }
    for (const payment of plan.payments) expect(entries.has(String(payment.id))).toBe(true);
  });

  it('has holds of both kinds, sites with bills, advances and promises open and broken', () => {
    const kinds = (rows: ReceivablesPlan['creditProfiles']) =>
      new Set(rows.map((row) => String(row.holdKind)));
    expect(kinds(plan.creditProfiles)).toEqual(new Set(['null', 'manual', 'auto']));
    expect(
      plan.creditProfiles.every(
        (row) => (row.holdKind === 'manual') === (row.heldByMemberId !== null),
      ),
    ).toBe(true);
    expect(plan.sites.length).toBeGreaterThan(10);
    expect(plan.invoices.some((invoice) => invoice.projectId !== null)).toBe(true);
    expect(plan.balances.some((balance) => Number(balance.advancePaise) > 0)).toBe(true);
    expect(plan.ledger.some((entry) => entry.entryType === 'opening')).toBe(true);
    expect(new Set(plan.promises.map((promise) => promise.status))).toEqual(
      new Set(['open', 'broken']),
    );
    expect(plan.escalations).toHaveLength(
      plan.promises.filter((promise) => promise.status === 'broken').length,
    );
    expect(plan.activities).toHaveLength(plan.promises.length);
    expect(plan.promises.every((promise) => promise.promisedOn >= String(promise.madeOn))).toBe(
      true,
    );
  });

  it('is the same for the same seed', () => {
    const again = planReceivables(new Random(7), input, {
      creditCustomers: 300,
      invoicesPerCustomer: 6,
    });
    const strip = (rows: readonly Record<string, unknown>[]) =>
      rows.map(({ id: _id, paymentId: _p, documentId: _d, partyLedgerId: _l, ...rest }) => rest);
    expect(strip(again.allocations)).toEqual(strip(plan.allocations));
    expect(again.invoices.map((invoice) => invoice.totalPaise)).toEqual(
      plan.invoices.map((invoice) => invoice.totalPaise),
    );
  });
});
