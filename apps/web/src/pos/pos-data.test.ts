import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api/client.js';
import { fakeFetch, json, type FakeHandler } from '../test-support/fake-api.js';
import { WALK_IN, billReducer, newBill } from './bill.js';
import { createDraftSaver } from './draft-saver.js';
import {
  billFromDraft,
  currentDraft,
  forgetDraft,
  readSnapshot,
  saveSnapshot,
  setCurrentDraft,
} from './held.js';
import { posEndpoints } from './pos-api.js';
import { MODES, document, draftLine, item } from './test-support/pos-fixtures.js';

function pos(routes: Record<string, FakeHandler>) {
  const api = fakeFetch(routes);
  return {
    requests: api.requests,
    pos: posEndpoints(
      createApiClient({
        baseUrl: '/api',
        fetch: api.fetch,
        getToken: () => 'tok',
        onUnauthorized: () => undefined,
      }),
    ),
  };
}

const missing = () => json({ statusCode: 404, message: 'Cannot GET' }, 404);

describe('posEndpoints', () => {
  it('calls the drafts, issue and print routes with idempotency keys', async () => {
    const { pos: calls, requests } = pos({
      'GET /invoices': () => json({ items: [], total: 0 }),
      'GET /invoices/:id': () => json(document()),
      'POST /invoices': () => json(document(), 201),
      'PUT /invoices/:id': () => json(document()),
      'DELETE /invoices/:id': () => ({ status: 204 }),
      'POST /invoices/:id/issue': () => json(document({ status: 'issued' })),
    });
    const input = { storeId: 's1', buyer: {}, lines: [] };
    await calls.drafts('s1');
    await calls.invoice('d1');
    await calls.createDraft(input, 'bill-1');
    await calls.updateDraft('d1', input);
    await calls.discardDraft('d1');
    await calls.issue('d1', [], 'k1');
    await calls.issue('d1', [{ modeId: 'm', amountPaise: 1 }], 'k2');
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /invoices',
      'GET /invoices/d1',
      'POST /invoices',
      'PUT /invoices/d1',
      'DELETE /invoices/d1',
      'POST /invoices/d1/issue',
      'POST /invoices/d1/issue',
    ]);
    expect(Object.fromEntries(requests[0]?.query ?? [])).toEqual({
      storeId: 's1',
      status: 'draft',
      limit: '50',
    });
    expect(requests[2]?.headers).toMatchObject({ 'Idempotency-Key': 'bill-1' });
    expect(requests[5]).toMatchObject({ body: {}, headers: { 'Idempotency-Key': 'k1' } });
    expect(requests[6]?.body).toEqual({ payments: [{ modeId: 'm', amountPaise: 1 }] });
  });

  it('reads the active payment modes and the store’s open register', async () => {
    const live = pos({
      'GET /payment-modes': () => json(MODES),
      'GET /register-sessions': (request) =>
        json({
          items:
            request.query.get('storeId') === 'open'
              ? [{ id: 'rs1', storeId: 'open', registerCode: 'C1', status: 'open' }]
              : [],
        }),
    });
    expect((await live.pos.paymentModes()).map((mode) => mode.id)).toEqual([
      'mode-upi',
      'mode-cash',
      'mode-card',
    ]);
    expect(await live.pos.register('open')).toMatchObject({ kind: 'open' });
    expect(await live.pos.register('shut')).toEqual({ kind: 'closed' });
    // A role without register:manage does not see the register.
    const cashier = pos({ 'GET /register-sessions': () => json({ message: 'Forbidden' }, 403) });
    expect(await cashier.pos.register('s1')).toEqual({ kind: 'hidden' });
    const broken = pos({ 'GET /register-sessions': () => json({ message: 'Down' }, 500) });
    await expect(broken.pos.register('s1')).rejects.toMatchObject({ status: 500 });
  });
});

describe('createDraftSaver', () => {
  it('creates once, then updates; an emptied bill discards its draft and a new one gets a new key', async () => {
    let created = 0;
    const { pos: calls, requests } = pos({
      'POST /invoices': () => {
        created += 1;
        return json(document({ id: `d${String(created)}`, kind: 'bill_of_supply' }), 201);
      },
      'PUT /invoices/:id': (request) => json(document({ id: request.path.split('/')[2] })),
      'DELETE /invoices/:id': () => ({ status: 204 }),
    });
    const saver = createDraftSaver(calls);
    const bill = billReducer(newBill('b1'), { type: 'add', item: item(), quantity: 1 });
    // Two quick saves: the second waits for the first draft instead of creating another.
    const [first, second] = await Promise.all([saver.save(bill, 's1'), saver.save(bill, 's1')]);
    expect(first).toEqual({ draftId: 'd1', kind: 'bill_of_supply', priceMode: 'inclusive' });
    expect(second.draftId).toBe('d1');
    const empty = billReducer(bill, { type: 'remove', index: 0 });
    expect(await saver.save(empty, 's1')).toEqual({ draftId: null });
    expect(await saver.save(empty, 's1')).toEqual({ draftId: null });
    expect((await saver.save(bill, 's1')).draftId).toBe('d2');
    expect(
      requests.map((request) => [request.method, request.headers['Idempotency-Key'] ?? '']),
    ).toEqual([
      ['POST', 'b1'],
      ['PUT', ''],
      ['DELETE', ''],
      ['POST', 'b1.1'],
    ]);
  });

  it('uses a resumed bill’s draft, keeps going after a failure and ignores a draft already gone', async () => {
    let fail = true;
    const { pos: calls } = pos({
      'PUT /invoices/:id': () =>
        fail ? json({ message: 'Down' }, 500) : json(document({ id: 'held-1' })),
      'DELETE /invoices/:id': missing,
    });
    const saver = createDraftSaver(calls);
    const bill = {
      ...billReducer(newBill('b2'), { type: 'add', item: item(), quantity: 1 }),
      draftId: 'held-1',
    };
    await expect(saver.save(bill, 's1')).rejects.toMatchObject({ status: 500 });
    fail = false;
    expect((await saver.save(bill, 's1')).draftId).toBe('held-1');
    const empty = billReducer(bill, { type: 'remove', index: 0 });
    expect(await saver.save(empty, 's1')).toEqual({ draftId: null });
  });

  it('reports a discard that fails', async () => {
    const { pos: calls } = pos({ 'DELETE /invoices/:id': () => json({ message: 'Down' }, 500) });
    const saver = createDraftSaver(calls);
    const bill = { ...newBill('b3'), draftId: 'd9' };
    await expect(saver.save(bill, 's1')).rejects.toMatchObject({ status: 500 });
  });
});

describe('held bills on this device', () => {
  it('remembers a saved bill and the counter’s current draft', () => {
    const bill = billReducer(newBill('b1'), { type: 'add', item: item(), quantity: 1 });
    saveSnapshot(localStorage, bill, 500);
    expect(localStorage.length).toBe(0);
    saveSnapshot(localStorage, { ...bill, draftId: 'd1' }, 500);
    expect(readSnapshot(localStorage, 'd1')).toMatchObject({ payablePaise: 500, buyer: WALK_IN });
    forgetDraft(localStorage, 'd1');
    expect(readSnapshot(localStorage, 'd1')).toBeNull();
    localStorage.setItem('pos.bill.bad', '{oops');
    expect(readSnapshot(localStorage, 'bad')).toBeNull();
    setCurrentDraft(localStorage, 's1', 'd2');
    expect(currentDraft(localStorage, 's1')).toBe('d2');
    setCurrentDraft(localStorage, 's1', null);
    expect(currentDraft(localStorage, 's1')).toBeNull();
  });

  it('rebuilds a held bill from its draft and what this device remembers', () => {
    const draft = document({
      priceMode: 'exclusive',
      buyer: { partyId: 'p1', name: 'Ravi', gstin: 'G', address: 'A', stateCode: '36' },
      lines: [
        draftLine({ quantity: 2, discountBps: 500 }),
        draftLine({
          id: 'l2',
          lineNo: 2,
          variantId: 'v-x',
          discountPaise: 100,
          taxCategoryId: 't',
        }),
      ],
    });
    const snapshot = {
      items: [item()],
      buyer: { ...WALK_IN, partyName: 'Remembered' },
      payablePaise: 1,
    };
    const bill = billFromDraft(draft, snapshot, 'k', (n) => `Item ${String(n)}`);
    expect(bill).toMatchObject({
      key: 'k',
      draftId: 'draft-1',
      selected: 1,
      priceMode: 'exclusive',
    });
    expect(bill.buyer.partyName).toBe('Remembered');
    expect(bill.lines).toEqual([
      { ...item(), quantity: 2, discount: { kind: 'percent', basisPoints: 500 }, tint: null },
      {
        variantId: 'v-x',
        sku: '',
        name: 'Item 2',
        taxCategoryId: 't',
        unitPricePaise: 1_045_000,
        quantity: 1,
        discount: { kind: 'amount', paise: 100 },
        tint: null,
      },
    ]);
    const bare = billFromDraft(draft, null, 'k', () => 'x');
    expect(bare.buyer).toEqual({
      ...WALK_IN,
      partyId: 'p1',
      name: 'Ravi',
      gstin: 'G',
      address: 'A',
      stateCode: '36',
    });
    expect(billFromDraft(document(), null, 'k', () => 'x').buyer).toEqual(WALK_IN);
    expect(billFromDraft(document({ lines: [] }), null, 'k', () => 'x').selected).toBeNull();
  });

  it('matches a remembered line by its place first, and never borrows another line’s shade', () => {
    const tint = {
      shadeCode: 'X 132',
      shadeName: null,
      brandId: null,
      machine: null,
      formula: [],
      tintChargePaise: 5_000,
      colorantCostPaise: null,
      note: null,
      basePricePaise: 1_045_000,
    };
    const snapshot = {
      items: [{ ...item(), tint }, item({ variantId: 'v-x', name: 'Roller' })],
      buyer: WALK_IN,
      payablePaise: 1,
    };
    // Saved out of order: line 2 is the tinted base, line 1 the roller.
    const draft = document({
      lines: [
        draftLine({ id: 'b', lineNo: 2, unitPricePaise: 1_050_000 }),
        draftLine({ id: 'a', lineNo: 1, variantId: 'v-x' }),
      ],
    });
    const bill = billFromDraft(draft, snapshot, 'k', () => 'x');
    expect(bill.lines.map((line) => [line.name, line.tint?.shadeCode ?? null])).toEqual([
      ['Roller', null],
      ['Asian Paints Apex Ultima 20 l', null],
    ]);
  });
});
