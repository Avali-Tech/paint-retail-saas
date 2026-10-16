import { describe, expect, it } from 'vitest';
import { PaymentLinkGateways } from './payment-link-gateways.js';
import { LogPaymentLinkProvider } from './payment-link-provider.js';

const URLS = { appUrl: 'https://app.example.in', publicApiUrl: 'https://api.example.in' };

describe('PaymentLinkGateways', () => {
  it('serves the log gateway to every business, or none when links are off', () => {
    const log = PaymentLinkGateways.fromConfig(
      { provider: 'log', credentialsKeys: null, razorpayApiUrl: 'https://api.razorpay.com/v1' },
      URLS,
    );
    expect(log.provider).toBe('log');
    expect(log.log).toBeInstanceOf(LogPaymentLinkProvider);
    const off = PaymentLinkGateways.fromConfig(
      {
        provider: 'disabled',
        credentialsKeys: null,
        razorpayApiUrl: 'https://api.razorpay.com/v1',
      },
      URLS,
    );
    expect(off.provider).toBeNull();
    expect(off.log).toBeNull();
  });

  it('needs the credentials key to seal a business’s Razorpay keys', () => {
    const none = new PaymentLinkGateways('razorpay', {
      ...URLS,
      vault: null,
      razorpay: { apiUrl: 'https://api.razorpay.com/v1' },
    });
    expect(() => none.vault).toThrow('No GATEWAY_CREDENTIALS_KEY');
    const keyed = PaymentLinkGateways.fromConfig(
      {
        provider: 'razorpay',
        credentialsKeys: { current: Buffer.alloc(32, 1), previous: null },
        razorpayApiUrl: 'https://api.razorpay.com/v1',
      },
      URLS,
    );
    expect(keyed.vault).toBeDefined();
    expect(keyed.webhookUrl('abcdefghijklmnopqrstuv')).toBe(
      'https://api.example.in/webhooks/payment-links/razorpay/abcdefghijklmnopqrstuv',
    );
  });
});
