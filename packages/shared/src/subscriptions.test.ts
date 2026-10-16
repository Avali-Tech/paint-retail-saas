import { describe, expect, it } from 'vitest';
import {
  isUpgrade,
  planBlockers,
  subscriptionCharge,
  subscriptionState,
  type SubscriptionRecord,
} from './subscriptions.js';

const NOW = new Date('2026-10-16T06:30:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const record = (change: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
  status: 'active',
  gateway: 'fake',
  trialEndsAt: null,
  currentPeriodEnd: at(20),
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  ...change,
});

describe('isUpgrade', () => {
  it('follows the catalogue order', () => {
    expect(isUpgrade('trial', 'starter')).toBe(true);
    expect(isUpgrade('standard', 'enterprise')).toBe(true);
    expect(isUpgrade('standard', 'starter')).toBe(false);
    expect(isUpgrade('standard', 'standard')).toBe(false);
  });
});

describe('subscriptionCharge', () => {
  it('prices per store with 18% GST, billing at least one store', () => {
    expect(subscriptionCharge('standard', 'monthly', 3)).toEqual({
      quantity: 3,
      unitPricePaise: 1_499_00,
      taxablePaise: 4_497_00,
      gstPaise: 809_46,
      totalPaise: 5_306_46,
    });
    expect(subscriptionCharge('starter', 'annual', 0)).toMatchObject({
      quantity: 1,
      taxablePaise: 7_990_00,
      totalPaise: 9_428_20,
    });
  });
});

describe('planBlockers', () => {
  it('lists usage over the plan’s limits, none for unlimited plans', () => {
    expect(planBlockers('starter', { stores: 3, members: 13 })).toEqual([
      { what: 'stores', used: 3, limit: 1 },
      { what: 'members', used: 13, limit: 5 },
    ]);
    expect(planBlockers('starter', { stores: 1, members: 5 })).toEqual([]);
    expect(planBlockers('enterprise', { stores: 300, members: 900 })).toEqual([]);
  });
});

describe('subscriptionState', () => {
  it('counts trial days left, rounding up, and expires the trial at its end', () => {
    expect(
      subscriptionState(
        record({ status: 'trialing', gateway: null, trialEndsAt: at(2.5) }),
        NOW,
        7,
      ),
    ).toEqual({ status: 'trialing', trialDaysLeft: 3, graceEndsAt: null, readOnly: false });
    expect(
      subscriptionState(record({ status: 'trialing', gateway: null, trialEndsAt: at(0) }), NOW, 7),
    ).toEqual({ status: 'expired', trialDaysLeft: null, graceEndsAt: null, readOnly: true });
  });

  it('keeps a paid period active until it ends, then is past due with a grace period', () => {
    expect(subscriptionState(record(), NOW, 7)).toEqual({
      status: 'active',
      trialDaysLeft: null,
      graceEndsAt: null,
      readOnly: false,
    });
    expect(subscriptionState(record({ currentPeriodEnd: at(-2) }), NOW, 7)).toEqual({
      status: 'past_due',
      trialDaysLeft: null,
      graceEndsAt: at(5),
      readOnly: false,
    });
    expect(subscriptionState(record({ currentPeriodEnd: at(-7) }), NOW, 7)).toMatchObject({
      status: 'past_due',
      readOnly: true,
    });
  });

  it('ends a subscription cancelled at period end when the period ends', () => {
    expect(
      subscriptionState(record({ cancelAtPeriodEnd: true, currentPeriodEnd: at(1) }), NOW, 7),
    ).toMatchObject({ status: 'active', readOnly: false });
    expect(
      subscriptionState(record({ cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }), NOW, 7),
    ).toMatchObject({ status: 'cancelled', readOnly: true });
  });

  it('takes a failed renewal’s past-due date from the gateway', () => {
    expect(subscriptionState(record({ status: 'past_due', pastDueSince: at(-1) }), NOW, 0)).toEqual(
      { status: 'past_due', trialDaysLeft: null, graceEndsAt: at(-1), readOnly: true },
    );
  });

  it('never lapses a plan the platform set by hand; cancelled and expired are read-only', () => {
    expect(
      subscriptionState(record({ gateway: null, currentPeriodEnd: null }), NOW, 7),
    ).toMatchObject({ status: 'active', readOnly: false });
    expect(subscriptionState(record({ status: 'cancelled' }), NOW, 7).readOnly).toBe(true);
    expect(subscriptionState(record({ status: 'expired' }), NOW, 7).readOnly).toBe(true);
  });
});
