import { migrateDatabase } from '@paint/db';
import type {
  NotificationPage,
  PaymentView,
  RegisterSessionSummary,
  RegisterSessionView,
  SalesSettingsView,
} from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  issuesOf,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, type TestApp } from '../test-support/test-app.js';

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const owner = () => api(t, b.owner);
const open = async (code: string, storeId = b.stores.amp, openingFloatPaise = 200_000) =>
  owner().post(`/registers/${code}/open`, { storeId, openingFloatPaise, note: 'Morning' });
const cash = (body: object) =>
  owner().post('/payments', {
    storeId: b.stores.amp,
    partyId: b.parties.contractor,
    modeId: b.modes.cash.id,
    amountPaise: 10_000,
    allocations: [],
    ...body,
  });
const session = async (id: string) =>
  ok(await owner().get(`/register-sessions/${id}`)).json<RegisterSessionView>();

describe('a day at the counter', () => {
  it('opens with a float, takes cash and refunds, moves cash, and closes with the variance', async () => {
    const opened = ok(await open('counter-1')).json<RegisterSessionView>();
    expect(opened).toMatchObject({
      registerCode: 'COUNTER-1',
      status: 'open',
      openingFloatPaise: 200_000,
      openingNote: 'Morning',
      openedBy: 'Owner',
      closedBy: null,
      expectedCashPaise: 200_000,
      countedCashPaise: null,
      movements: [],
      modeTotals: [],
    });
    expect((await open('COUNTER-1')).statusCode).toBe(409);
    expect((await open('counter 1')).statusCode).toBe(400);

    const payment = ok(await cash({ tenderedPaise: 10_000 })).json<PaymentView>();
    expect(payment.registerSessionId).toBe(opened.id);
    const upi = ok(
      await cash({ modeId: b.modes.upi.id, registerSessionId: opened.id, amountPaise: 7_000 }),
    ).json<PaymentView>();
    expect(upi.registerSessionId).toBe(opened.id);
    ok(
      await owner().post(`/payments/${payment.id}/refund`, {
        modeId: b.modes.cash.id,
        amountPaise: 2_500,
      }),
    );
    const move = (kind: string, amountPaise: number) =>
      owner().post(`/register-sessions/${opened.id}/movements`, {
        kind,
        amountPaise,
        reason: `${kind} for the day`,
      });
    ok(await move('pay_in', 5_000));
    ok(await move('pay_out', 1_200));
    const during = ok(await move('bank_deposit', 100_000)).json<RegisterSessionView>();
    const expected = 200_000 + 10_000 - 2_500 + 5_000 - 1_200 - 100_000;
    expect(during).toMatchObject({
      expectedCashPaise: expected,
      cashInPaise: 10_000,
      cashOutPaise: 2_500,
    });
    expect(during.movements.map((m) => [m.kind, m.amountPaise])).toEqual([
      ['pay_in', 5_000],
      ['pay_out', 1_200],
      ['bank_deposit', 100_000],
    ]);
    expect(during.modeTotals.map((m) => [m.name, m.inPaise, m.outPaise, m.count])).toEqual([
      ['Cash', 10_000, 2_500, 2],
      ['UPI', 7_000, 0, 1],
    ]);

    // Counted short by ₹12: the managers hear (no alert threshold set yet).
    const manager = await b.member('branch_manager', [b.stores.amp]);
    const close = (body: object) => owner().post(`/register-sessions/${opened.id}/close`, body);
    expect(issuesOf(await close({ denominations: { '50000': 1 }, countedCashPaise: 1 }))).toEqual([
      'countedCashPaise',
    ]);
    expect((await close({ denominations: { '700': 1 } })).statusCode).toBe(400);
    expect((await close({})).statusCode).toBe(400);
    const closed = ok(
      await close({ denominations: { '50000': 2, '10000': 1, '100': 1 }, note: 'Short' }),
    ).json<RegisterSessionView>();
    expect(closed).toMatchObject({
      status: 'closed',
      expectedCashPaise: expected,
      countedCashPaise: 110_100,
      variancePaise: 110_100 - expected,
      denominations: { '50000': 2, '10000': 1, '100': 1 },
      closingNote: 'Short',
      openedBy: 'Owner',
      closedBy: 'Owner',
    });
    expect(closed.variancePaise).toBe(-1_200);
    const notices = ok(await api(t, manager).get('/notifications')).json<NotificationPage>();
    expect(notices.items[0]).toMatchObject({
      event: 'register_variance',
      title: 'Register COUNTER-1 closed short by ₹12.00',
    });

    // Closed is final.
    expect((await close({ countedCashPaise: 1 })).statusCode).toBe(409);
    expect((await move('pay_in', 1)).statusCode).toBe(409);
    expect((await cash({ registerSessionId: opened.id })).statusCode).toBe(409);
    expect((await cash({})).statusCode).toBe(409);
    expect(await session(opened.id)).toMatchObject({ expectedCashPaise: expected });
  });

  it('alerts only above the threshold, and lets cash in without a register when set so', async () => {
    const settings = ok(
      await owner().put('/sales/settings', { registerVarianceAlertPaise: 5_000 }),
    ).json<SalesSettingsView>();
    expect(settings).toMatchObject({ cashNeedsRegister: true, registerVarianceAlertPaise: 5_000 });
    const manager = await b.member('branch_manager', [b.stores.amp]);
    const opened = ok(await open('COUNTER-2', b.stores.amp, 0)).json<RegisterSessionView>();
    const over = ok(
      await owner().post(`/register-sessions/${opened.id}/close`, { countedCashPaise: 4_000 }),
    ).json<RegisterSessionView>();
    expect(over).toMatchObject({ countedCashPaise: 4_000, variancePaise: 4_000 });
    expect(ok(await api(t, manager).get('/notifications')).json<NotificationPage>().total).toBe(0);
    const third = ok(await open('COUNTER-3', b.stores.amp, 0)).json<RegisterSessionView>();
    ok(await owner().post(`/register-sessions/${third.id}/close`, { countedCashPaise: 6_000 }));
    expect(
      ok(await api(t, manager).get('/notifications')).json<NotificationPage>().items[0]?.title,
    ).toBe('Register COUNTER-3 closed over by ₹60.00');

    ok(await owner().put('/sales/settings', { cashNeedsRegister: false }));
    const loose = ok(await cash({})).json<PaymentView>();
    expect(loose.registerSessionId).toBeNull();
    ok(await owner().put('/sales/settings', { cashNeedsRegister: true }));
  });

  it('asks which register when several are open, and keeps each to its store', async () => {
    const first = ok(await open('A1')).json<RegisterSessionView>();
    const second = ok(await open('A2')).json<RegisterSessionView>();
    const kkp = ok(await open('K1', b.stores.kkp)).json<RegisterSessionView>();
    expect(issuesOf(await cash({}))).toEqual(['registerSessionId']);
    expect(issuesOf(await cash({ registerSessionId: kkp.id }))).toEqual(['registerSessionId']);
    expect(ok(await cash({ registerSessionId: second.id })).json<PaymentView>()).toMatchObject({
      registerSessionId: second.id,
    });

    const list = async (query: string) =>
      ok(await owner().get(`/register-sessions?${query}`)).json<{
        items: RegisterSessionSummary[];
        total: number;
      }>();
    expect((await list(`storeId=${b.stores.kkp}`)).items.map((s) => s.id)).toEqual([kkp.id]);
    expect((await list('status=open')).items.map((s) => s.id).sort()).toEqual(
      [first.id, second.id, kkp.id].sort(),
    );
    expect((await list('status=closed&limit=1')).total).toBe(3);

    const kkpCashier = await b.member('store_employee', [b.stores.kkp]);
    const theirs = api(t, kkpCashier);
    expect((await theirs.get(`/register-sessions/${first.id}`)).statusCode).toBe(404);
    expect(
      (await theirs.post('/registers/A9/open', { storeId: b.stores.amp, openingFloatPaise: 0 }))
        .statusCode,
    ).toBe(403);
    expect(
      issuesOf(
        await theirs.post('/registers/A9/open', {
          storeId: crypto.randomUUID(),
          openingFloatPaise: 0,
        }),
      ),
    ).toEqual(['storeId']);
    expect((await list('')).total).toBe(6);
    const visible = ok(await theirs.get('/register-sessions')).json<{ total: number }>();
    expect(visible.total).toBe(1);
    expect(
      (await api(t, await b.member('sales_executive', [b.stores.amp])).get('/register-sessions'))
        .statusCode,
    ).toBe(403);
  });

  it("never shows another business's registers", async () => {
    const other = await billingBusiness(t);
    const mine = ok(await open('Z1')).json<RegisterSessionView>();
    const them = api(t, other.owner);
    expect((await them.get(`/register-sessions/${mine.id}`)).statusCode).toBe(404);
    expect(
      (
        await them.post(`/register-sessions/${mine.id}/movements`, {
          kind: 'pay_in',
          amountPaise: 1,
          reason: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect(ok(await them.get('/register-sessions')).json<{ total: number }>().total).toBe(0);
  });
});
