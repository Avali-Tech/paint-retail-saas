import { describe, expect, it } from 'vitest';
import { GatewayError } from '../payments-gateway/payment-gateway.js';
import { ManualGateway } from './manual-gateway.js';

describe('ManualGateway', () => {
  const gateway = new ManualGateway();

  it('starts nothing online and believes no webhook', async () => {
    expect(gateway.name).toBe('manual');
    await expect(gateway.createSubscription()).rejects.toBeInstanceOf(GatewayError);
    await expect(gateway.fetchSubscription()).rejects.toThrow('no gateway subscriptions');
    expect(gateway.verifyWebhook()).toBeNull();
  });

  it('has nobody to tell about a plan change or a cancellation', async () => {
    await expect(gateway.changePlan()).resolves.toBeUndefined();
    await expect(gateway.cancelAtPeriodEnd()).resolves.toBeUndefined();
  });
});
