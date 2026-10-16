import { describe, expect, it } from 'vitest';
import { hmacHex } from '../payments-gateway/signatures.js';
import {
  LOG_SIGNATURE_HEADER,
  LogPaymentLinkProvider,
  paymentLinkProviderFor,
} from './payment-link-provider.js';

const APP = 'https://app.example.in';

describe('LogPaymentLinkProvider', () => {
  it('makes a link on a page of the web app and remembers what it made and cancelled', async () => {
    const provider = new LogPaymentLinkProvider(APP);
    const request = {
      reference: 'PL-000001',
      amountPaise: 118_000,
      description: 'Rangoli Paints: Invoice AMP/26-27/000001',
      expiresAt: new Date('2026-10-23T00:00:00Z'),
      customer: { name: 'Ravi', mobile: '+919811100032' },
    };
    const created = await provider.createPayment(request);
    expect(created.gatewayReference).toMatch(/^plink_log_[\w-]{22}$/);
    expect(LogPaymentLinkProvider.isReference(created.gatewayReference)).toBe(true);
    expect(LogPaymentLinkProvider.isReference('plink_rzp_123')).toBe(false);
    expect(created.url).toBe(`${APP}/pay/${created.gatewayReference}`);
    expect(provider.created).toEqual([request]);
    await provider.cancelPayment(created.gatewayReference);
    expect(provider.cancelled).toEqual([created.gatewayReference]);
  });

  it('believes only what it signed itself, and translates its events', () => {
    const provider = new LogPaymentLinkProvider(APP);
    const paidAt = new Date('2026-10-16T05:00:00Z');
    const paid = provider.webhook({
      id: 'evt_1',
      type: 'payment.captured',
      linkId: 'plink_log_1',
      payment: { id: 'pay_1', amountPaise: 500, paidAt },
    });
    expect(provider.verifyWebhook(paid.body, { [LOG_SIGNATURE_HEADER]: paid.signature })).toEqual({
      id: 'evt_1',
      gatewayType: 'payment.captured',
      gatewayLinkId: 'plink_log_1',
      kind: 'paid',
      payment: { id: 'pay_1', amountPaise: 500, paidAt },
    });
    expect(provider.verifyWebhook(paid.body, { [LOG_SIGNATURE_HEADER]: 'forged' })).toBeNull();
    expect(provider.verifyWebhook(paid.body, {})).toBeNull();
    // Another process's provider has another secret.
    const other = new LogPaymentLinkProvider(APP);
    expect(other.verifyWebhook(paid.body, { [LOG_SIGNATURE_HEADER]: paid.signature })).toBeNull();

    for (const [type, kind] of [
      ['link.expired', 'expired'],
      ['link.cancelled', 'cancelled'],
      ['payment_link.updated', 'ignored'],
      // A payment event without a payment says nothing to act on.
      ['payment.captured', 'ignored'],
    ] as const) {
      const webhook = provider.webhook({ type, linkId: 'plink_log_2' });
      expect(
        provider.verifyWebhook(webhook.body, { [LOG_SIGNATURE_HEADER]: webhook.signature }),
      ).toMatchObject({ kind, payment: null, gatewayLinkId: 'plink_log_2', gatewayType: type });
    }
  });

  it('makes up event and payment ids and the time when not given', () => {
    const provider = new LogPaymentLinkProvider(APP);
    const webhook = provider.webhook({
      type: 'payment.captured',
      linkId: 'plink_log_3',
      payment: { amountPaise: 100 },
    });
    const event = provider.verifyWebhook(webhook.body, {
      [LOG_SIGNATURE_HEADER]: webhook.signature,
    });
    expect(event?.id).toMatch(/^evt_log_/);
    expect(event?.payment?.id).toMatch(/^pay_log_/);
    expect(Math.abs(Number(event?.payment?.paidAt.getTime()) - Date.now())).toBeLessThan(60_000);
  });

  it('refuses a signed body of another shape', () => {
    const provider = new LogPaymentLinkProvider(APP);
    const secret = (provider as unknown as { secret: string }).secret;
    const signed = (body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body));
      return provider.verifyWebhook(raw, { [LOG_SIGNATURE_HEADER]: hmacHex(secret, raw) });
    };
    const good = { id: 'e', type: 'payment.captured', linkId: 'l', payment: null };
    expect(signed(good)).not.toBeNull();
    for (const bad of [
      null,
      'text',
      { ...good, id: 1 },
      { ...good, type: null },
      { ...good, linkId: undefined },
      { ...good, payment: 'x' },
      { ...good, payment: { id: 'p', amountPaise: 0, paidAt: '2026-10-16T00:00:00Z' } },
      { ...good, payment: { id: 'p', amountPaise: 1.5, paidAt: '2026-10-16T00:00:00Z' } },
      { ...good, payment: { id: 2, amountPaise: 1, paidAt: '2026-10-16T00:00:00Z' } },
      { ...good, payment: { id: 'p', amountPaise: 1, paidAt: 'yesterday' } },
      { ...good, payment: { id: 'p', amountPaise: 1, paidAt: 5 } },
    ]) {
      expect(signed(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('paymentLinkProviderFor', () => {
  it('makes the log provider, or none when links are off', () => {
    expect(paymentLinkProviderFor('log', APP)).toBeInstanceOf(LogPaymentLinkProvider);
    expect(paymentLinkProviderFor('disabled', APP)).toBeNull();
  });
});
