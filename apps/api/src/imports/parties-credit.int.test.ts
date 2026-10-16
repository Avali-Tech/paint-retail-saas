import { migrateDatabase, schema } from '@paint/db';
import { toCsv } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

// Credit limits and days in the parties import (PO-101).

interface Report {
  totals: { rows: number; create: number; update: number; unchanged: number; errors: number };
  rows: { row: number; action: string; label: string }[];
  errors: { row: number; column: string | null; message: string }[];
}
interface Credit {
  status: string;
  limitPaise: number;
  creditDays: number;
  approvedBy: { name: string } | null;
}
interface AuditPage {
  items: {
    recordLabel: string | null;
    actor: { name: string } | null;
    changes: { label: string; oldText: string | null; newText: string | null }[];
  }[];
}
type Reply = Awaited<ReturnType<TestApp['app']['inject']>>;

const HEADER = ['name', 'roles', 'phone', 'credit_limit', 'credit_days'];
const file = (...rows: string[][]) => toCsv([HEADER, ...rows]);

let database: TestDatabase;
let t: TestApp;
let owner: string;
let manager: string;
let hyd: string;

const get = (url: string, token = owner) =>
  t.app.inject({ method: 'GET', url, headers: bearer(token) });
const post = (url: string, payload: object, token = owner) =>
  t.app.inject({ method: 'POST', url, headers: bearer(token), payload });
const preview = (csv: string, token = owner) => post('/imports/parties/preview', { csv }, token);
const commit = (csv: string, token = owner) => post('/imports/parties', { csv }, token);
const report = (reply: Reply) =>
  reply.statusCode === 400 ? reply.json<{ report: Report }>().report : reply.json<Report>();
const partyByPhone = async (phone: string) =>
  (await get(`/parties?q=${encodeURIComponent(phone)}`)).json<{ items: { id: string }[] }>()
    .items[0]?.id ?? '';
const creditOf = async (phone: string) =>
  (await get(`/parties/${await partyByPhone(phone)}/credit`)).json<Credit>();

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'Credit Import Paints',
      fullName: 'Asha Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  owner = signup.json<{ token: string }>().token;
  hyd = (await post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{ id: string }>().id;
  const roles = (await get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  await post('/members', {
    fullName: 'Branch Manager',
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === 'branch_manager')?.id,
    storeIds: [hyd],
  });
  manager = (
    await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { identifier: phone, password: 'Staff@2026' },
    })
  ).json<{ token: string }>().token;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('credit in the parties import', () => {
  it('gives new and existing customers a limit and days, approved by the importer and audited', async () => {
    const newPhone = uniquePhone();
    const existingPhone = uniquePhone();
    await post('/parties', {
      displayName: 'Existing Builders',
      phone: existingPhone,
      roles: ['customer'],
    });

    const checked = report(
      await preview(
        file(
          ['New Contractors', 'customer;contractor', newPhone, '₹1,50,000.50', '45'],
          ['Existing Builders', 'customer', existingPhone, '80000', '0'],
        ),
      ),
    );
    expect(checked.rows).toEqual([
      {
        row: 2,
        action: 'create',
        label: 'New Contractors · credit ₹1,50,000.50, 45 days',
      },
      { row: 3, action: 'update', label: 'Existing Builders · credit ₹80,000.00, 0 days' },
    ]);
    // A preview saves nothing.
    expect((await creditOf(existingPhone)).status).toBe('none');

    const saved = await commit(
      file(
        ['New Contractors', 'customer;contractor', newPhone, '₹1,50,000.50', '45'],
        ['Existing Builders', 'customer', existingPhone, '80000', '0'],
      ),
    );
    expect(saved.statusCode).toBe(201);
    expect(await creditOf(newPhone)).toMatchObject({
      status: 'active',
      limitPaise: 15_000_050,
      creditDays: 45,
      approvedBy: { name: 'Asha Owner' },
    });
    expect(await creditOf(existingPhone)).toMatchObject({
      status: 'active',
      limitPaise: 8_000_000,
      creditDays: 0,
    });

    const audit = (await get('/audit-log?table=credit_profiles&limit=200')).json<AuditPage>();
    const entry = audit.items.find((item) => item.recordLabel === 'New Contractors');
    expect(entry?.actor?.name).toBe('Asha Owner');
    expect(entry?.changes.map((change) => [change.label, change.newText])).toEqual(
      expect.arrayContaining([
        ['Status', 'active'],
        ['Credit limit', '₹1,50,000.50'],
        ['Credit days', '45'],
      ]),
    );
  });

  it('updates a profile when imported again; blank cells and the same figures change nothing', async () => {
    const phone = uniquePhone();
    await commit(file(['Repeat Customer', 'customer', phone, '50000', '30']));

    const same = report(await commit(file(['Repeat Customer', 'customer', phone, '50000', '30'])));
    const blank = report(await commit(file(['Repeat Customer', 'customer', phone, '', ''])));
    const daysOnly = report(await commit(file(['Repeat Customer', 'customer', phone, '', '60'])));

    expect([same.rows[0]?.action, blank.rows[0]?.action]).toEqual(['unchanged', 'unchanged']);
    expect(daysOnly.rows[0]).toMatchObject({
      action: 'update',
      label: 'Repeat Customer · credit ₹50,000.00, 60 days',
    });
    expect(await creditOf(phone)).toMatchObject({ limitPaise: 5_000_000, creditDays: 60 });
  });

  it('keeps a party on hold on hold', async () => {
    const phone = uniquePhone();
    await commit(file(['Held Customer', 'customer', phone, '20000', '15']));
    const id = await partyByPhone(phone);
    await post(`/parties/${id}/credit/hold`, { reason: 'Cheque bounced' });

    await commit(file(['Held Customer', 'customer', phone, '25000', '']));

    expect(await creditOf(phone)).toMatchObject({
      status: 'on_hold',
      limitPaise: 2_500_000,
      creditDays: 15,
    });
  });

  it('works after billing goes live: the hand-entered exposure is not touched', async () => {
    const phone = uniquePhone();
    await commit(file(['Before Live', 'customer', phone, '10000', '7']));
    expect((await post('/sales/go-live', {})).statusCode).toBe(200);

    const saved = await commit(file(['Before Live', 'customer', phone, '12000', '']));

    expect(saved.statusCode).toBe(201);
    expect(await creditOf(phone)).toMatchObject({ limitPaise: 1_200_000, creditDays: 7 });
    const [profile] = await t.connection.db
      .select({ manual: schema.creditProfiles.manualExposurePaise })
      .from(schema.creditProfiles)
      .where(eq(schema.creditProfiles.partyId, await partyByPhone(phone)));
    expect(profile?.manual).toBe(0);
  });

  it('checks each credit cell and row', async () => {
    const pendingPhone = uniquePhone();
    await commit(file(['Waiting Customer', 'customer', pendingPhone, '', '']));
    const pendingId = await partyByPhone(pendingPhone);
    const request = await post('/credit-requests', {
      partyId: pendingId,
      limitPaise: 1_000_000,
      creditDays: 30,
    });
    const number = request.json<{ number: string }>().number;

    const response = await preview(
      file(
        ['Zero Limit', 'customer', uniquePhone(), '0', '30'],
        ['Huge Limit', 'customer', uniquePhone(), '100000000.01', '30'],
        ['Not Rupees', 'customer', uniquePhone(), 'lots', '30'],
        ['Part Days', 'customer', uniquePhone(), '1000', '2.5'],
        ['Long Days', 'customer', uniquePhone(), '1000', '366'],
        ['Minus Days', 'customer', uniquePhone(), '1000', '-1'],
        ['Supplier Credit', 'supplier', uniquePhone(), '1000', '30'],
        ['Days Only', 'customer', uniquePhone(), '', '30'],
        ['Limit Only', 'customer', uniquePhone(), '1000', ''],
        ['Waiting Customer', 'customer', pendingPhone, '20000', '30'],
      ),
    );

    expect(report(response).errors.map((e) => [e.row, e.column, e.message])).toEqual([
      [2, 'credit_limit', 'Must be more than zero'],
      [3, 'credit_limit', 'At most ₹10,00,00,000'],
      [4, 'credit_limit', 'Enter an amount in rupees, such as 1250.50'],
      [5, 'credit_days', 'Enter whole days'],
      [6, 'credit_days', 'At most 365 days'],
      [7, 'credit_days', 'Cannot be negative'],
      [8, 'credit_limit', 'Credit is for customers: add the customer role'],
      [9, 'credit_limit', 'Enter a credit limit: this party has no credit yet'],
      [10, 'credit_days', 'Enter the credit days: this party has no credit yet'],
      [11, 'credit_limit', `${number} is waiting for approval: approve or reject it first`],
    ]);
  });

  it('is for credit approvers only; others import parties without credit', async () => {
    const phone = uniquePhone();
    const refused = await commit(
      file(['Manager Customer', 'customer', phone, '5000', '10']),
      manager,
    );
    expect(refused.statusCode).toBe(400);
    expect(report(refused).errors).toEqual([
      {
        row: 2,
        column: 'credit_limit',
        message:
          'Only credit approvers can set credit by import; ask for credit on the customer page',
      },
    ]);

    const saved = await commit(file(['Manager Customer', 'customer', phone, '', '']), manager);
    expect(saved.statusCode).toBe(201);
    expect((await creditOf(phone)).status).toBe('none');
  });
});
