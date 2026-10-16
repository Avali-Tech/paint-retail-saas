import { describe, expect, it } from 'vitest';
import { hmacHex } from '../payments-gateway/signatures.js';
import { GatewayError } from '../payments-gateway/payment-gateway.js';
import { LOG_SIGNATURE_HEADER, LogPaymentLinkProvider } from './payment-link-provider.js';

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
      refund: null,
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
    expect(signed({ ...good, refund: null })).not.toBeNull();
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
      { ...good, linkId: 5 },
      { ...good, refund: 'x' },
      { ...good, refund: { id: 1, paymentId: 'p', amountPaise: 1 } },
      { ...good, refund: { id: 'r', paymentId: 2, amountPaise: 1 } },
      { ...good, refund: { id: 'r', paymentId: 'p', amountPaise: 0 } },
    ]) {
      expect(signed(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('LogPaymentLinkProvider refunds', () => {
  const request = {
    gatewayPaymentId: 'pay_log_1',
    amountPaise: 6_400,
    receipt: 'refund-1',
    notes: { link: 'PL-000001' },
  };

  it('takes a refund at once, once per receipt', async () => {
    const provider = new LogPaymentLinkProvider(APP);
    const first = await provider.refundPayment(request);
    expect(first).toEqual({
      gatewayRefundId: expect.stringMatching(/^rfnd_log_[\w-]{22}$/) as string,
      status: 'processed',
    });
    expect(await provider.refundPayment(request)).toEqual(first);
    expect(provider.refunds.get('refund-1')).toMatchObject({ amountPaise: 6_400 });
  });

  it('refuses, or cannot be reached, when a test says so', async () => {
    const provider = new LogPaymentLinkProvider(APP);
    provider.refundBehaviour = 'reject';
    await expect(provider.refundPayment(request)).rejects.toMatchObject({
      code: 'BAD_REQUEST_ERROR',
      retryable: false,
    });
    provider.refundBehaviour = 'unreachable';
    const error = await provider.refundPayment(request).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('signs refund news, and ignores news about nothing', () => {
    const provider = new LogPaymentLinkProvider(APP);
    const refund = { id: 'rfnd_log_1', paymentId: 'pay_log_1', amountPaise: 6_400 };
    for (const [type, kind] of [
      ['refund.processed', 'refund_processed'],
      ['refund.failed', 'refund_failed'],
    ] as const) {
      const webhook = provider.webhook({ type, refund });
      expect(
        provider.verifyWebhook(webhook.body, { [LOG_SIGNATURE_HEADER]: webhook.signature }),
      ).toMatchObject({ kind, gatewayLinkId: null, payment: null, refund });
    }
    const nothing = provider.webhook({ type: 'refund.processed' });
    expect(
      provider.verifyWebhook(nothing.body, { [LOG_SIGNATURE_HEADER]: nothing.signature }),
    ).toMatchObject({ kind: 'ignored', gatewayLinkId: null, refund: null });
  });
});

describe('GatewayError', () => {
  it('is a plain gateway error, not to be retried, unless it says otherwise', () => {
    expect(new GatewayError('no')).toMatchObject({ code: 'gateway_error', retryable: false });
  });
});
