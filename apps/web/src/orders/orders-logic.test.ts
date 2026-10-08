import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import { newBill, type BillLine } from '../pos/bill.js';
import { fakeFetch, json } from '../test-support/fake-api.js';
import { INVOICE } from '../test-support/sales-fixtures.js';
import { dispatchValuePaise } from './DispatchPanel.js';
import { confirmRefusalText } from './OrderDialogs.js';
import { ordersEndpoints } from './orders-api.js';
import {
  EMPTY_HEADER,
  editorStateOf,
  lineKeyAction,
  orderRequest,
  problemsOf,
  quotationRequest,
  type SalesHeader,
} from './sales-doc.js';
import { whatsappLink } from './status.js';
import { HINGE_LINE, ORDER, QUOTE, SENT_QUOTE } from './test-support/order-fixtures.js';

const LINE: BillLine = {
  variantId: 'v-apex-20',
  sku: 'APX-20L',
  name: 'Apex 20 l',
  taxCategoryId: null,
  unitPricePaise: 5_000_00,
  quantity: 2,
  discount: null,
};
const READY: SalesHeader = {
  ...EMPTY_HEADER,
  storeId: 'store-amp',
  billTo: { id: 'party-1', name: 'Apex Builders' },
};

describe('problemsOf', () => {
  it('names every missing or wrong field', () => {
    expect(problemsOf(EMPTY_HEADER, [], '2026-10-08', 'quotation')).toEqual({
      storeId: 'required',
      billTo: 'required',
      lines: 'noLines',
    });
    expect(
      problemsOf(
        { ...READY, validUntil: '2026-10-07', shipToName: 'Site', note: 'x'.repeat(501) },
        Array.from({ length: 201 }, () => LINE),
        '2026-10-08',
        'quotation',
      ),
    ).toEqual({
      validUntil: 'pastDate',
      shipToState: 'shipToState',
      note: 'noteLong',
      lines: 'tooManyLines',
    });
  });

  it('accepts a complete document; orders have no validity date', () => {
    expect(
      problemsOf({ ...READY, validUntil: '2026-10-08' }, [LINE], '2026-10-08', 'quotation'),
    ).toEqual({});
    expect(
      problemsOf(
        { ...READY, validUntil: '2020-01-01', shipToAddress: 'Plot 1', shipToState: '36' },
        [LINE],
        '2026-10-08',
        'order',
      ),
    ).toEqual({});
  });
});

describe('requests', () => {
  it('leaves out what is not given', () => {
    expect(quotationRequest(READY, [LINE])).toEqual({
      storeId: 'store-amp',
      billToPartyId: 'party-1',
      lines: [{ variantId: 'v-apex-20', quantity: 2, unitPricePaise: 5_000_00 }],
    });
    expect(orderRequest(READY, [])).toEqual({
      storeId: 'store-amp',
      billToPartyId: 'party-1',
      lines: [],
      paymentTerms: 'postpaid',
    });
  });

  it('sends influencer, site, ship-to, validity, note and discounts', () => {
    const header: SalesHeader = {
      ...READY,
      influencer: { id: 'painter-1', name: 'Ramesh' },
      projectId: 'project-1',
      shipToName: ' Site office ',
      shipToAddress: '',
      shipToState: '36',
      validUntil: '2026-10-30',
      paymentTerms: 'prepaid',
      note: ' After 5 pm ',
    };
    const lines = [{ ...LINE, discount: { kind: 'percent', basisPoints: 500 } as const }];
    expect(quotationRequest(header, lines)).toEqual({
      storeId: 'store-amp',
      billToPartyId: 'party-1',
      influencerPartyId: 'painter-1',
      projectId: 'project-1',
      shipTo: { name: 'Site office', stateCode: '36' },
      note: 'After 5 pm',
      validUntil: '2026-10-30',
      lines: [
        {
          variantId: 'v-apex-20',
          quantity: 2,
          unitPricePaise: 5_000_00,
          discount: { kind: 'percent', basisPoints: 500 },
        },
      ],
    });
    expect(orderRequest(header, lines).paymentTerms).toBe('prepaid');
  });
});

describe('editorStateOf', () => {
  it('starts empty, or from a saved quote or order', () => {
    expect(editorStateOf(null).header).toBe(EMPTY_HEADER);
    const quote = editorStateOf(QUOTE);
    expect(quote.header).toEqual({
      storeId: 'store-amp',
      billTo: { id: QUOTE.billTo.id, name: 'Apex Builders' },
      influencer: { id: 'painter-1', name: 'Ramesh Painter' },
      projectId: 'project-1',
      shipToName: 'Site office',
      shipToAddress: 'Plot 12, Madhapur',
      shipToState: '36',
      validUntil: '2026-10-22',
      paymentTerms: 'postpaid',
      note: 'Delivery after 5 pm',
    });
    expect(quote.bill.lines.map((line) => line.discount)).toEqual([
      { kind: 'percent', basisPoints: 1000 },
      { kind: 'amount', paise: 0 },
    ]);
    const bare = editorStateOf(SENT_QUOTE).header;
    expect([bare.projectId, bare.shipToName, bare.shipToState, bare.note]).toEqual([
      '',
      '',
      '',
      '',
    ]);
    const order = editorStateOf({
      ...ORDER,
      paymentTerms: 'partial',
      lines: [{ ...ORDER.lines[0], ...HINGE_LINE, discountPaise: null }] as typeof ORDER.lines,
    });
    expect(order.header.paymentTerms).toBe('partial');
    expect(order.header.validUntil).toBe('');
    expect(order.bill.lines[0]?.discount).toBeNull();
  });
});

describe('lineKeyAction', () => {
  const bill = { ...newBill('k'), lines: [LINE, LINE, LINE], selected: 1 };
  it('acts on the selected line like the counter', () => {
    expect(lineKeyAction({ ...bill, selected: null }, 'more')).toBeNull();
    expect(lineKeyAction(bill, 'more')).toEqual({ type: 'step', index: 1, by: 1 });
    expect(lineKeyAction(bill, 'less')).toEqual({ type: 'step', index: 1, by: -1 });
    expect(lineKeyAction(bill, 'remove')).toEqual({ type: 'remove', index: 1 });
    expect(lineKeyAction(bill, 'down')).toEqual({ type: 'select', index: 2 });
    expect(lineKeyAction({ ...bill, selected: 2 }, 'down')).toEqual({ type: 'select', index: 2 });
    expect(lineKeyAction({ ...bill, selected: 0 }, 'up')).toEqual({ type: 'select', index: 0 });
  });
});

describe('whatsappLink', () => {
  it('goes to an Indian mobile, a full number, or lets WhatsApp ask', () => {
    expect(whatsappLink('98480 12345', 'Hi & bye')).toBe(
      'https://wa.me/919848012345?text=Hi%20%26%20bye',
    );
    expect(whatsappLink('+919848012345', 'x')).toBe('https://wa.me/919848012345?text=x');
    expect(whatsappLink(null, 'x')).toBe('https://wa.me/?text=x');
  });
});

describe('dispatchValuePaise', () => {
  it('values the goods with tax, pro rata, ignoring unknown lines', () => {
    expect(
      dispatchValuePaise(INVOICE, [
        { invoiceLineId: 'line-2', quantity: 1 },
        { invoiceLineId: 'nope', quantity: 4 },
      ]),
    ).toBe(50_000);
  });
});

describe('confirmRefusalText', () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    `${key}${params === undefined ? '' : JSON.stringify(params)}`;
  const number = (value: number) => String(value);
  const money = (paise: number) => `₹${String(paise)}`;
  it('spells out each short line of a 409, and nothing else', () => {
    const refusal = new ApiError(409, 'Short', [], [], {
      code: 'insufficient_stock',
      lines: [{ lineId: 'ol-1', lineNo: 1, storeId: 's', wantedQuantity: 2, availableQuantity: 1 }],
    });
    expect(confirmRefusalText(refusal, t as never, number, money)).toBe(
      'orders.confirm.short orders.confirm.shortLine{"line":1,"wanted":"2","available":"1"}',
    );
    expect(
      confirmRefusalText(
        new ApiError(409, 'Credit', [], [], { code: 'x' }),
        t as never,
        number,
        money,
      ),
    ).toBeNull();
    expect(confirmRefusalText(new Error('x'), t as never, number, money)).toBeNull();
    expect(
      confirmRefusalText(
        new ApiError(409, 'Advance', [], [], {
          code: 'advance_required',
          advanceRequiredPaise: 4_500_00,
          advancePaise: 1_000_00,
        }),
        t as never,
        number,
        money,
      ),
    ).toBe('orders.confirm.advanceShort{"required":"₹450000","advance":"₹100000"}');
  });
});

describe('ordersEndpoints', () => {
  it('calls round 4a’s routes with idempotency keys where they create', async () => {
    const api = fakeFetch({
      'GET /quotations': () => json({ items: [], total: 0 }),
      'GET /quotations/:id': () => json(QUOTE),
      'POST /quotations': () => json(QUOTE, 201),
      'PUT /quotations/:id': () => json(QUOTE),
      'POST /quotations/:id/revise': () => json(QUOTE),
      'POST /quotations/:id/send': () => json(QUOTE),
      'POST /quotations/:id/accept': () => json(QUOTE),
      'POST /quotations/:id/convert': () => json(ORDER),
      'GET /sales-orders': () => json({ items: [], total: 0 }),
      'GET /sales-orders/:id': () => json(ORDER),
      'POST /sales-orders': () => json(ORDER),
      'PUT /sales-orders/:id': () => json(ORDER),
      'GET /sales-orders/:id/availability': () => json({ lines: [] }),
      'GET /sales-orders/:id/credit-check': () => json({}),
      'POST /sales-orders/:id/confirm': () => json(ORDER),
      'POST /sales-orders/:id/cancel': () => json(ORDER),
      'POST /sales-orders/:id/lines/:lineId/cancel': () => json(ORDER),
      'POST /sales-orders/:id/reserve': () => json(ORDER),
      'POST /sales-orders/:id/release': () => json(ORDER),
      'POST /sales-orders/:id/invoices': () => json(INVOICE),
      'POST /invoices/:id/issue': () => json(INVOICE),
      'GET /invoices/:id/dispatches': () => json({}),
      'POST /invoices/:id/dispatches': () => json({}),
    });
    const orders = ordersEndpoints(
      createApiClient({
        baseUrl: '/api',
        fetch: api.fetch,
        getToken: () => null,
        onUnauthorized: () => undefined,
      }),
    );
    const body = { storeId: 's', billToPartyId: 'p', lines: [] };
    await orders.quotations({ status: 'sent', limit: 50, offset: 0 });
    await orders.quotation('q1');
    await orders.createQuotation(body, 'k1');
    await orders.updateQuotation('q1', body);
    await orders.reviseQuotation('q1');
    await orders.sendQuotation('q1');
    await orders.acceptQuotation('q1');
    await orders.convertQuotation('q1', { paymentTerms: 'prepaid' }, 'k2');
    await orders.orders({ q: 'SO', limit: 50, offset: 50 });
    await orders.order('o1');
    await orders.createOrder({ ...body, paymentTerms: 'postpaid' }, 'k3');
    await orders.updateOrder('o1', { ...body, paymentTerms: 'postpaid' });
    await orders.availability('o1');
    await orders.creditCheck('o1');
    await orders.confirmOrder('o1', {}, 'k4');
    await orders.cancelOrder('o1', 'No longer needed');
    await orders.cancelLine('o1', 'l1', { reason: 'Changed' });
    await orders.reserve('o1', {});
    await orders.release('o1');
    await orders.bill('o1', { storeId: 's' }, 'k5');
    await orders.issue('i1', {}, 'k6');
    await orders.dispatches('i1');
    await orders.dispatch('i1', {}, 'k7');
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /quotations',
      'GET /quotations/q1',
      'POST /quotations',
      'PUT /quotations/q1',
      'POST /quotations/q1/revise',
      'POST /quotations/q1/send',
      'POST /quotations/q1/accept',
      'POST /quotations/q1/convert',
      'GET /sales-orders',
      'GET /sales-orders/o1',
      'POST /sales-orders',
      'PUT /sales-orders/o1',
      'GET /sales-orders/o1/availability',
      'GET /sales-orders/o1/credit-check',
      'POST /sales-orders/o1/confirm',
      'POST /sales-orders/o1/cancel',
      'POST /sales-orders/o1/lines/l1/cancel',
      'POST /sales-orders/o1/reserve',
      'POST /sales-orders/o1/release',
      'POST /sales-orders/o1/invoices',
      'POST /invoices/i1/issue',
      'GET /invoices/i1/dispatches',
      'POST /invoices/i1/dispatches',
    ]);
    const keys = api.requests
      .map((request) => request.headers['Idempotency-Key'])
      .filter((key) => key !== undefined);
    expect(keys).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    expect(api.requests[0]?.query.toString()).toBe('status=sent&limit=50&offset=0');
    expect(api.requests[15]?.body).toEqual({ reason: 'No longer needed' });
  });
});
