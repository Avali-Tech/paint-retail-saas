import { createHmac, randomBytes } from 'node:crypto';

/**
 * A stand-in for Razorpay's API in tests (no network): the Payment Links, Payments and
 * Refunds endpoints the adapter calls, answering as Razorpay's documented samples do,
 * for any number of businesses' accounts (keys registered with `account`).
 */
export class FakeRazorpay {
  readonly requests: { method: string; path: string; keyId: string | null; body: unknown }[] = [];
  private readonly accounts = new Map<string, string>();
  private readonly refunds = new Map<string, { id: string; status: string; receipt: string }[]>();
  /** Refunds answer this until changed: Razorpay refuses or takes them. */
  refundAnswer: 'processed' | 'pending' | 'insufficient_balance' = 'processed';
  /** The harmless test call answers this: fine, or something that is not JSON. */
  testAnswer: 'ok' | 'garbage' = 'ok';
  private serial = 0;

  /** A business's Razorpay keys, as its dashboard would show them. */
  account(live = true): { keyId: string; keySecret: string; webhookSecret: string } {
    this.serial += 1;
    const keyId = `rzp_${live ? 'live' : 'test'}_${randomBytes(7).toString('hex')}`;
    const keySecret = randomBytes(12).toString('hex');
    this.accounts.set(keyId, keySecret);
    return { keyId, keySecret, webhookSecret: `whsec-${randomBytes(8).toString('hex')}` };
  }

  /** Razorpay's webhook signature: hex HMAC-SHA256 of the raw body with the secret. */
  static sign(body: Buffer, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex');
  }

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(7).toString('hex')}`;
  }

  readonly fetch = ((input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = `${url.pathname.replace(/^\/v1/, '')}${url.search}`;
    const method = String(init?.method);
    const basic = new Headers(init?.headers).get('authorization')?.replace(/^Basic /, '') ?? '';
    const [keyId = null, keySecret] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, keyId, body });
    const answer = (status: number, json: unknown) =>
      Promise.resolve(new Response(JSON.stringify(json), { status }));
    if (keyId === null || this.accounts.get(keyId) !== keySecret) {
      return answer(401, {
        error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' },
      });
    }
    if (method === 'GET' && path.startsWith('/payments?')) {
      return this.testAnswer === 'ok'
        ? answer(200, { entity: 'collection', count: 0, items: [] })
        : Promise.resolve(new Response('<html>Bad gateway</html>', { status: 200 }));
    }
    if (method === 'POST' && path === '/payment_links') {
      const id = this.id('plink');
      const request = body as { reference_id: string; amount: number };
      return answer(200, {
        id,
        short_url: `https://rzp.io/i/${id.slice(6)}`,
        status: 'created',
        reference_id: request.reference_id,
        amount: request.amount,
      });
    }
    const cancel = /^\/payment_links\/(plink_\w+)\/cancel$/.exec(path);
    if (method === 'POST' && cancel) return answer(200, { id: cancel[1], status: 'cancelled' });
    const refund = /^\/payments\/(pay_\w+)\/refund$/.exec(path);
    if (method === 'POST' && refund) {
      const paymentId = String(refund[1]);
      const { receipt } = body as { receipt: string };
      const made = this.refunds.get(paymentId) ?? [];
      if (made.some((one) => one.receipt === receipt)) {
        return answer(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Duplicate receipt found for this refund request.',
          },
        });
      }
      if (this.refundAnswer === 'insufficient_balance') {
        return answer(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description:
              'Your account does not have enough balance to carry out the refund operation.',
          },
        });
      }
      const taken = { id: this.id('rfnd'), status: this.refundAnswer, receipt };
      this.refunds.set(paymentId, [...made, taken]);
      return answer(200, { ...taken, entity: 'refund', payment_id: paymentId });
    }
    const list = /^\/payments\/(pay_\w+)\/refunds\?count=100$/.exec(path);
    if (method === 'GET' && list) {
      return answer(200, { items: this.refunds.get(String(list[1])) ?? [] });
    }
    return answer(404, { error: { code: 'NOT_FOUND', description: `${method} ${path}` } });
  }) as unknown as typeof globalThis.fetch;
}
