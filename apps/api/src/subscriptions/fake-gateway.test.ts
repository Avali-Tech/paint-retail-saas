import { describe, expect, it } from 'vitest';
import { FAKE_SIGNATURE_HEADER, FakeGateway } from './fake-gateway.js';

describe('FakeGateway', () => {
  it('opens its checkout page in the web app and records what it is asked', async () => {
    const gateway = new FakeGateway('https://app.example');
    const created = await gateway.createSubscription({
      checkoutId: 'checkout-1',
      organizationId: 'org-1',
      plan: 'starter',
      interval: 'monthly',
      quantity: 1,
      totalPaise: 942_82,
    });
    expect(created).toEqual({
      gatewaySubscriptionId: expect.stringMatching(/^sub_fake_[0-9a-f]{32}$/),
      checkoutUrl: 'https://app.example/billing/checkout/checkout-1',
    });
    expect(await gateway.fetchSubscription(created.gatewaySubscriptionId)).toEqual({
      id: created.gatewaySubscriptionId,
      status: 'active',
      currentStart: null,
      currentEnd: null,
    });
  });

  it('verifies only webhooks it signed itself', () => {
    const gateway = new FakeGateway('https://app.example');
    const { body, headers } = gateway.webhook('charged', 'sub_fake_1', {
      amountPaise: 942_82,
      id: 'pay_fixed',
    });
    expect(gateway.verifyWebhook(body, headers)).toEqual({
      id: expect.stringMatching(/^evt_fake_/),
      type: 'charged',
      gatewayType: 'charged',
      gatewaySubscriptionId: 'sub_fake_1',
      paymentId: 'pay_fixed',
      amountPaise: 942_82,
      periodStart: null,
      periodEnd: null,
    });
    const another = new FakeGateway('https://app.example');
    expect(another.verifyWebhook(body, headers)).toBeNull();
    expect(gateway.verifyWebhook(body, { [FAKE_SIGNATURE_HEADER]: undefined })).toBeNull();
  });
});
