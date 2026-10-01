import { migrateDatabase, schema } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuditPage } from '../audit/audit.service.js';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import type { PartyOverview } from '../parties/party-overview.service.js';
import type { SearchResults } from '../search/search.service.js';
import { istDate } from '../test-support/business.js';
import { multipartBody, PDF, testBucket } from '../test-support/files.js';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';
import { addDays } from './contract-dates.js';
import type { ContractPage, ContractView } from './contracts.service.js';

let database: TestDatabase;
let t: TestApp;
let owner: string;
/** Branch manager at Hyderabad: can manage contracts there and business-wide ones. */
let manager: string;
/** Sales executive at Hyderabad: can read contracts only. */
let sales: string;
/** Store employee at Hyderabad: cannot see contracts. */
let cashier: string;
const ids: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});
const id = (key: string) => String(ids[key]);
const message = (response: { body: string }) =>
  (JSON.parse(response.body) as { message: string }).message;

/** A one-year contractor agreement ending `endsIn` days from today. */
const agreement = (values: Record<string, unknown> = {}, endsIn = 200) => ({
  type: 'contractor_agreement',
  title: 'Annual rate contract',
  partyId: id('contractor'),
  startDate: istDate(endsIn - 365),
  endDate: istDate(endsIn),
  ...values,
});

async function create(token: string, values: Record<string, unknown> = {}, endsIn = 200) {
  const response = await api(token).post('/contracts', agreement(values, endsIn));
  if (response.statusCode !== 201) throw new Error(response.body);
  return response.json<ContractView>();
}

async function active(values: Record<string, unknown> = {}, endsIn = 200) {
  const draft = await create(owner, values, endsIn);
  return (await api(owner).post(`/contracts/${draft.id}/activate`)).json<ContractView>();
}

/** Moves a contract's dates directly, e.g. into the past. */
const setDates = (contractId: string, start: number, end: number, renewal = end) =>
  t.connection.db
    .update(schema.contracts)
    .set({ startDate: istDate(start), endDate: istDate(end), renewalDate: istDate(renewal) })
    .where(eq(schema.contracts.id, contractId));

async function hire(roleKey: string, storeIds: string[]) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  const member = await api(owner).post('/members', {
    fullName: `Staff ${roleKey}`,
    phone,
    password: 'Staff@2026',
    roleId: roles.find((role) => role.key === roleKey)?.id,
    storeIds,
  });
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return {
    token: login.json<{ token: string }>().token,
    memberId: member.json<{ id: string }>().id,
  };
}

const idOf = async (response: ReturnType<ReturnType<typeof api>['post']>) => {
  const reply = await response;
  if (reply.statusCode >= 400) throw new Error(reply.body);
  return reply.json<{ id: string }>().id;
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  const env = await testBucket(
    inject('objectStorageEndpoint'),
    inject('virusScannerAddress'),
    'contracts-test',
  );
  t = await startTestApp(database.connectionString, env);
  const signup = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: 'ABC Paints',
      fullName: 'Anil Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  owner = signup.json<{ token: string }>().token;
  const o = api(owner);
  ids.hyd = await idOf(o.post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  ids.pune = await idOf(o.post('/stores', { name: 'Pune', code: 'PUN' }));
  const hired = await hire('branch_manager', [id('hyd')]);
  manager = hired.token;
  ids.managerMember = hired.memberId;
  const salesHire = await hire('sales_executive', [id('hyd')]);
  sales = salesHire.token;
  ids.salesMember = salesHire.memberId;
  cashier = (await hire('store_employee', [id('hyd')])).token;
  ids.contractor = await idOf(
    o.post('/parties', {
      displayName: 'Raj Contractors',
      phone: uniquePhone(),
      roles: ['contractor'],
    }),
  );
  ids.supplier = await idOf(
    o.post('/parties', { kind: 'organization', displayName: 'Asian Depot', roles: ['supplier'] }),
  );
  ids.project = await idOf(
    o.post('/projects', {
      storeId: id('hyd'),
      customerPartyId: id('contractor'),
      name: 'Gachibowli Heights',
    }),
  );
  ids.puneProject = await idOf(
    o.post('/projects', {
      storeId: id('pune'),
      customerPartyId: id('contractor'),
      name: 'Pune office',
    }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('creating contracts', () => {
  it('records a business-wide supplier agreement as a draft, renewal due 30 days before the end', async () => {
    const response = await api(owner).post('/contracts', {
      type: 'supplier_agreement',
      title: 'Asian Paints distribution 2026-27',
      partyId: id('supplier'),
      startDate: '2026-04-01',
      endDate: '2027-03-31',
    });

    expect(response.statusCode).toBe(201);
    const contract = response.json<ContractView>();
    expect(contract).toMatchObject({
      number: expect.stringMatching(/^CT-\d{6}$/) as string,
      type: 'supplier_agreement',
      title: 'Asian Paints distribution 2026-27',
      party: { id: id('supplier'), name: 'Asian Depot', phone: null },
      store: null,
      project: null,
      startDate: '2026-04-01',
      endDate: '2027-03-31',
      renewalDate: '2027-03-01',
      valuePaise: null,
      terms: null,
      creditTerms: null,
      discountTerms: null,
      notes: null,
      status: 'draft',
      renewalDue: false,
      terminationReason: null,
      renewalOf: null,
      renewedBy: null,
      assignedTo: { name: 'Anil Owner' },
      endedAt: null,
    });
    expect(contract.daysToEnd).toBe(
      Math.round((Date.parse('2027-03-31') - Date.parse(istDate(0))) / 86_400_000),
    );
    expect((await api(owner).get(`/contracts/${contract.id}`)).json()).toEqual(contract);
  });

  it('takes the store from the project, with terms, value and an assignee', async () => {
    const contract = await create(owner, {
      projectId: id('project'),
      renewalDate: istDate(100),
      valuePaise: 25_00_000_00,
      terms: 'Rates fixed for the year',
      creditTerms: '30 days',
      discountTerms: '5% above ₹10 lakh a quarter',
      notes: 'Signed at the Kondapur office',
      assignedMemberId: id('managerMember'),
    });

    expect(contract).toMatchObject({
      store: { id: id('hyd'), code: 'HYD', name: 'Hyderabad' },
      project: { id: id('project'), name: 'Gachibowli Heights' },
      renewalDate: istDate(100),
      valuePaise: 25_00_000_00,
      terms: 'Rates fixed for the year',
      creditTerms: '30 days',
      discountTerms: '5% above ₹10 lakh a quarter',
      notes: 'Signed at the Kondapur office',
      assignedTo: { memberId: id('managerMember'), name: 'Staff branch_manager' },
    });
    const withStore = await create(manager, { storeId: id('hyd'), projectId: id('project') });
    expect(withStore.store?.id).toBe(id('hyd'));
    expect(withStore.assignedTo.memberId).toBe(id('managerMember'));
  });

  it('numbers contracts one after another', async () => {
    const first = await create(owner);
    const second = await create(owner);

    expect(Number(second.number.slice(3)) - Number(first.number.slice(3))).toBe(1);
  });

  it('refuses unknown or unreachable parties, projects, stores and assignees', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const attempts = await Promise.all([
      api(owner).post('/contracts', agreement({ partyId: ghost })),
      api(owner).post('/contracts', agreement({ projectId: ghost })),
      api(manager).post('/contracts', agreement({ projectId: id('puneProject') })),
      api(owner).post('/contracts', agreement({ projectId: id('project'), storeId: id('pune') })),
      api(manager).post('/contracts', agreement({ storeId: id('pune') })),
      api(owner).post('/contracts', agreement({ assignedMemberId: id('salesMember') })),
    ]);

    expect(attempts.map((r) => [r.statusCode, message(r)])).toEqual([
      [400, 'Unknown party'],
      [400, 'Unknown project'],
      [400, 'Unknown project'],
      [400, 'The project belongs to another store'],
      [404, 'Store not found'],
      [400, 'Choose someone who works at this store and handles contracts'],
    ]);
  });

  it('refuses dates out of order', async () => {
    const backwards = await api(owner).post(
      '/contracts',
      agreement({ startDate: '2026-12-01', endDate: '2026-11-01' }),
    );
    const lateRenewal = await api(owner).post(
      '/contracts',
      agreement({ endDate: '2026-11-01', renewalDate: '2026-11-02' }),
    );

    expect(backwards.statusCode).toBe(400);
    expect(lateRenewal.statusCode).toBe(400);
    expect(
      [backwards, lateRenewal].map((r) =>
        r.json<{ issues: { path: string }[] }>().issues.map((i) => i.path),
      ),
    ).toEqual([['endDate'], ['renewalDate']]);
  });
});

describe('status', () => {
  it('activates a draft once, and not after it has ended', async () => {
    const draft = await create(owner);
    const activated = await api(owner).post(`/contracts/${draft.id}/activate`);
    const again = await api(owner).post(`/contracts/${draft.id}/activate`);
    const ended = await create(owner, {}, -1);
    const late = await api(owner).post(`/contracts/${ended.id}/activate`);

    expect([activated.statusCode, activated.json<ContractView>().status]).toEqual([200, 'active']);
    expect([again.statusCode, message(again)]).toEqual([409, 'This contract is active']);
    expect([late.statusCode, message(late)]).toEqual([409, 'This contract has already ended']);
  });

  it('shows an active contract past its end as expired and due for renewal', async () => {
    const contract = await active();
    await setDates(contract.id, -400, -2, -30);

    const expired = (await api(owner).get(`/contracts/${contract.id}`)).json<ContractView>();

    expect(expired).toMatchObject({ status: 'expired', renewalDue: true, daysToEnd: -2 });
  });

  it('terminates a draft or active contract with a reason, then allows no changes', async () => {
    const contract = await active();
    const terminated = await api(owner).post(`/contracts/${contract.id}/terminate`, {
      reason: 'Contractor stopped buying',
    });
    const draft = await create(owner);
    const cancelled = await api(owner).post(`/contracts/${draft.id}/terminate`, {
      reason: 'Never signed',
    });

    expect(terminated.statusCode).toBe(200);
    const view = terminated.json<ContractView>();
    expect(view).toMatchObject({
      status: 'terminated',
      terminationReason: 'Contractor stopped buying',
      renewalDue: false,
    });
    expect(view.endedAt).toEqual(expect.any(String));
    expect(cancelled.json<ContractView>().status).toBe('terminated');
    for (const response of [
      await api(owner).post(`/contracts/${contract.id}/terminate`, { reason: 'Again' }),
      await api(owner).patch(`/contracts/${contract.id}`, { title: 'New' }),
      await api(owner).post(`/contracts/${contract.id}/renew`, { endDate: istDate(900) }),
    ]) {
      expect([response.statusCode, message(response)]).toEqual([
        409,
        'This contract is terminated',
      ]);
    }
    expect(
      (await api(owner).post(`/contracts/${contract.id}/terminate`, { reason: 'x' })).statusCode,
    ).toBe(400);
  });
});

describe('changing a contract', () => {
  it('changes terms, value and dates; moving the end resets the renewal date', async () => {
    const contract = await create(owner, { valuePaise: 100, terms: 'Old terms' });
    const changed = await api(owner).patch(`/contracts/${contract.id}`, {
      title: 'Rate contract 2026',
      type: 'customer_agreement',
      valuePaise: null,
      terms: null,
      creditTerms: '45 days',
    });
    const moved = await api(owner).patch(`/contracts/${contract.id}`, { endDate: istDate(300) });
    const chosen = await api(owner).patch(`/contracts/${contract.id}`, {
      renewalDate: istDate(250),
    });

    expect(changed.json<ContractView>()).toMatchObject({
      title: 'Rate contract 2026',
      type: 'customer_agreement',
      valuePaise: null,
      terms: null,
      creditTerms: '45 days',
      renewalDate: contract.renewalDate,
    });
    expect(moved.json<ContractView>()).toMatchObject({
      endDate: istDate(300),
      renewalDate: istDate(270),
    });
    expect(chosen.json<ContractView>().renewalDate).toBe(istDate(250));
  });

  it('refuses changes that put the dates out of order, or an assignee who cannot handle contracts', async () => {
    const contract = await create(owner);
    const attempts = [
      await api(owner).patch(`/contracts/${contract.id}`, { endDate: istDate(-200) }),
      await api(owner).patch(`/contracts/${contract.id}`, { renewalDate: istDate(201) }),
      await api(owner).patch(`/contracts/${contract.id}`, {
        assignedMemberId: id('salesMember'),
      }),
    ];
    const empty = await api(owner).patch(`/contracts/${contract.id}`, {});
    const reassigned = await api(owner).patch(`/contracts/${contract.id}`, {
      assignedMemberId: id('managerMember'),
    });

    expect(attempts.map((r) => [r.statusCode, message(r)])).toEqual([
      [400, 'The end date cannot be before the start date'],
      [400, 'The renewal date cannot be after the end date'],
      [400, 'Choose someone who works at this store and handles contracts'],
    ]);
    expect(empty.statusCode).toBe(400);
    expect(reassigned.json<ContractView>().assignedTo.memberId).toBe(id('managerMember'));
  });
});

describe('renewing', () => {
  it('creates the follow-on contract from the day after the end, copying the terms', async () => {
    const contract = await active({ valuePaise: 50_000_00, terms: 'Rates as per annexure' });
    await setDates(contract.id, -365, -1, -31);

    const response = await api(owner).post(`/contracts/${contract.id}/renew`, {
      endDate: istDate(365),
    });

    expect(response.statusCode).toBe(201);
    const renewal = response.json<ContractView>();
    expect(renewal).toMatchObject({
      status: 'active',
      title: contract.title,
      type: 'contractor_agreement',
      startDate: istDate(0),
      endDate: istDate(365),
      renewalDate: istDate(335),
      valuePaise: 50_000_00,
      terms: 'Rates as per annexure',
      renewalOf: { id: contract.id, number: contract.number },
      renewedBy: null,
      assignedTo: contract.assignedTo,
    });
    expect(renewal.number).not.toBe(contract.number);
    const old = (await api(owner).get(`/contracts/${contract.id}`)).json<ContractView>();
    expect(old).toMatchObject({
      status: 'renewed',
      renewalDue: false,
      renewedBy: { id: renewal.id, number: renewal.number },
    });
    expect(old.endedAt).toEqual(expect.any(String));
  });

  it('takes new dates, title and terms when given', async () => {
    const contract = await active({ projectId: id('project'), valuePaise: 100, notes: 'Old' });

    const renewal = (
      await api(owner).post(`/contracts/${contract.id}/renew`, {
        startDate: istDate(150),
        endDate: istDate(600),
        renewalDate: istDate(500),
        title: 'Rate contract, second year',
        valuePaise: null,
        terms: 'New rates',
        creditTerms: '15 days',
        discountTerms: 'None',
        notes: null,
      })
    ).json<ContractView>();

    expect(renewal).toMatchObject({
      title: 'Rate contract, second year',
      startDate: istDate(150),
      endDate: istDate(600),
      renewalDate: istDate(500),
      valuePaise: null,
      terms: 'New rates',
      creditTerms: '15 days',
      discountTerms: 'None',
      notes: null,
      store: { id: id('hyd') },
      project: { id: id('project') },
    });
  });

  it('renews only active contracts, once, and not to end before it starts', async () => {
    const draft = await create(owner);
    const contract = await active({}, 50);
    const backwards = await api(owner).post(`/contracts/${contract.id}/renew`, {
      endDate: istDate(40),
    });
    const notActive = await api(owner).post(`/contracts/${draft.id}/renew`, {
      endDate: istDate(900),
    });
    const both = await Promise.all([
      api(owner).post(`/contracts/${contract.id}/renew`, { endDate: istDate(400) }),
      api(owner).post(`/contracts/${contract.id}/renew`, { endDate: istDate(400) }),
    ]);

    expect([backwards.statusCode, message(backwards)]).toEqual([
      400,
      'The end date cannot be before the start date',
    ]);
    expect([notActive.statusCode, message(notActive)]).toEqual([409, 'This contract is draft']);
    expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('lists and access', () => {
  let puneContract: ContractView;
  let dueSoon: ContractView;
  let dueLater: ContractView;

  beforeAll(async () => {
    puneContract = await active({
      storeId: id('pune'),
      title: 'Pune painters rate card',
      type: 'dealer_agreement',
    });
    dueSoon = await active({ storeId: id('hyd'), title: 'Kukatpally rate card' }, 10);
    dueLater = await active({ partyId: id('supplier'), title: 'Primer supply' }, 25);
  });

  const list = async (token: string, query = '') =>
    (await api(token).get(`/contracts?${query}`)).json<ContractPage>();

  it('lists contracts ending soon, soonest first, including expired ones not yet renewed', async () => {
    const page = await list(owner, 'renewalDue=30&limit=200');

    const numbers = page.items.map((c) => c.number);
    expect(numbers.indexOf(dueSoon.number)).toBeLessThan(numbers.indexOf(dueLater.number));
    expect(numbers).not.toContain(puneContract.number);
    expect(page.items.every((c) => c.status === 'active' || c.status === 'expired')).toBe(true);
    const ends = page.items.map((c) => c.endDate);
    expect(ends).toEqual([...ends].sort());
    expect(page.items.find((c) => c.id === dueSoon.id)).toMatchObject({
      daysToEnd: 10,
      renewalDue: true,
      store: { code: 'HYD' },
      party: { name: 'Raj Contractors' },
    });
  });

  it('filters by status, type, party, store, project, assignee and text', async () => {
    const titles = async (query: string) =>
      (await list(owner, `${query}&limit=200`)).items.map((c) => c.title);

    expect(await titles('type=dealer_agreement')).toEqual(['Pune painters rate card']);
    expect(await titles(`partyId=${id('supplier')}&status=active`)).toEqual(['Primer supply']);
    expect(await titles(`storeId=${id('pune')}`)).toEqual(['Pune painters rate card']);
    expect(await titles('q=kukatpally')).toEqual(['Kukatpally rate card']);
    expect(await titles('q=asian%20depot&status=active')).toEqual(['Primer supply']);
    expect(await titles(`q=${dueSoon.number}`)).toEqual(['Kukatpally rate card']);
    expect((await list(owner, 'status=expired')).items.length).toBeGreaterThan(0);
    expect(
      (await list(owner, 'status=expired&limit=200')).items.every((c) => c.status === 'expired'),
    ).toBe(true);
    expect(
      (await list(owner, `projectId=${id('project')}&limit=200`)).items.length,
    ).toBeGreaterThan(0);
    expect(
      (await list(manager, 'assignedTo=me&limit=200')).items.every(
        (c) => c.assignedTo.memberId === id('managerMember'),
      ),
    ).toBe(true);
    const page = await list(owner, 'limit=1');
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(5);
  });

  it('shows members business-wide contracts and those of their stores only', async () => {
    const seen = (await list(manager, 'limit=200')).items;

    expect(seen.map((c) => c.id)).toEqual(expect.arrayContaining([dueSoon.id, dueLater.id]));
    expect(seen.map((c) => c.id)).not.toContain(puneContract.id);
    expect(seen.every((c) => c.store === null || c.store.code === 'HYD')).toBe(true);
    expect((await api(manager).get(`/contracts/${puneContract.id}`)).statusCode).toBe(404);
    expect((await api(manager).get(`/contracts?storeId=${id('pune')}`)).statusCode).toBe(404);
    expect(
      (await api(manager).post(`/contracts/${puneContract.id}/terminate`, { reason: 'Mine' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(owner).get('/contracts/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
  });

  it('lets sales read but not change contracts, and keeps them from store employees', async () => {
    expect((await api(sales).get(`/contracts/${dueSoon.id}`)).statusCode).toBe(200);
    expect((await api(sales).post('/contracts', agreement())).statusCode).toBe(403);
    expect((await api(sales).post(`/contracts/${dueSoon.id}/activate`)).statusCode).toBe(403);
    expect((await api(cashier).get('/contracts')).statusCode).toBe(403);
  });

  it('appear in the customer 360 and in search, for members who may see contracts', async () => {
    const overview = (
      await api(owner).get(`/parties/${id('supplier')}/overview`)
    ).json<PartyOverview>();
    const hidden = (
      await api(cashier).get(`/parties/${id('supplier')}/overview`)
    ).json<PartyOverview>();
    const found = (await api(owner).get('/search?q=primer%20supply')).json<SearchResults>();
    const unseen = (await api(cashier).get('/search?q=primer%20supply')).json<SearchResults>();

    expect(overview.contracts).toMatchObject({ active: 1, renewalDue: 1 });
    expect(overview.contracts?.total).toBeGreaterThanOrEqual(2);
    expect(overview.contracts?.items.find((c) => c.id === dueLater.id)).toEqual({
      id: dueLater.id,
      number: dueLater.number,
      title: 'Primer supply',
      type: 'contractor_agreement',
      status: 'active',
      startDate: dueLater.startDate,
      endDate: dueLater.endDate,
      renewalDate: dueLater.renewalDate,
      renewalDue: true,
      valuePaise: null,
    });
    expect(hidden.contracts).toBeNull();
    expect(found.contracts).toEqual([
      {
        id: dueLater.id,
        title: `${dueLater.number} · Primer supply`,
        subtitle: `Asian Depot · active · ends ${dueLater.endDate}`,
        path: `/contracts/${dueLater.id}`,
      },
    ]);
    expect(unseen.contracts).toBeNull();
  });
});

describe('documents', () => {
  const attach = (token: string, recordId: string) => {
    const { payload, headers } = multipartBody(
      { recordType: 'contract', recordId, category: 'contract' },
      [{ fileName: 'Signed agreement.pdf', data: PDF }],
    );
    return t.app.inject({
      method: 'POST',
      url: '/documents',
      headers: { ...bearer(token), ...headers },
      payload,
    });
  };
  const documentsOf = (token: string, recordId: string) =>
    api(token).get(`/documents?recordType=contract&recordId=${recordId}`);

  it('attaches the signed agreement to business-wide and store contracts', async () => {
    const wide = await create(owner);
    const pune = await create(owner, { storeId: id('pune') });

    expect((await attach(manager, wide.id)).statusCode).toBe(201);
    expect((await attach(owner, pune.id)).statusCode).toBe(201);
    expect(
      (await documentsOf(sales, wide.id)).json<{ fileName: string }[]>().map((d) => d.fileName),
    ).toEqual(['Signed agreement.pdf']);
    expect((await documentsOf(manager, pune.id)).statusCode).toBe(404);
    expect((await attach(sales, wide.id)).statusCode).toBe(403);
    expect((await documentsOf(owner, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('renewal reminders', () => {
  const worker = () => t.app.get(NotificationsWorker);
  const inbox = async (token: string) =>
    (await api(token).get('/notifications'))
      .json<{ items: { event: string; title: string; body: string; link: string }[] }>()
      .items.filter((n) => n.event === 'contract_renewal_due');

  it('reminds the assignee once when a contract is 30 days from its end', async () => {
    await worker().remindContractRenewals();
    const before = (await inbox(manager)).length;
    const contract = await active(
      { storeId: id('hyd'), assignedMemberId: id('managerMember'), title: 'Painting labour' },
      30,
    );
    // A draft and a contract with a later renewal date are not reminded yet.
    await create(owner, { assignedMemberId: id('managerMember') }, 30);
    await active({ assignedMemberId: id('managerMember') }, 31);

    expect(contract.renewalDate).toBe(istDate(0));
    const run = await worker().runOnce();
    const again = await worker().remindContractRenewals();

    expect(run.contractRenewals).toBe(1);
    expect(again).toBe(0);
    const notices = await inbox(manager);
    expect(notices).toHaveLength(before + 1);
    expect(notices[0]).toEqual(
      expect.objectContaining({
        title: `Contract due for renewal: ${contract.number} · Painting labour`,
        body: expect.stringMatching(/^Raj Contractors — ends \d{2} \w{3} \d{4}$/) as string,
        link: `/contracts/${contract.id}`,
      }),
    );
    expect(await inbox(sales)).toEqual([]);
  });

  it('reminds again after the renewal date is moved', async () => {
    const contract = await active({ assignedMemberId: id('managerMember') }, 20);
    await worker().remindContractRenewals();
    await api(owner).patch(`/contracts/${contract.id}`, { renewalDate: istDate(5) });

    expect(await worker().remindContractRenewals()).toBe(0);
    await api(owner).patch(`/contracts/${contract.id}`, { renewalDate: istDate(0) });
    expect(await worker().remindContractRenewals()).toBe(1);
    // The same date again changes nothing, so no second reminder.
    await api(owner).patch(`/contracts/${contract.id}`, { renewalDate: istDate(0) });
    expect(await worker().remindContractRenewals()).toBe(0);
  });
});

describe('audit', () => {
  it('records who created a contract and changed its status, dates and value', async () => {
    const contract = await create(manager, { valuePaise: 10_000_00 });
    await api(owner).post(`/contracts/${contract.id}/activate`);
    await api(owner).patch(`/contracts/${contract.id}`, {
      endDate: addDays(contract.endDate, 30),
      valuePaise: 12_000_00,
      notes: 'Not audited',
    });

    const page = (
      await api(owner).get(`/audit-log?table=contracts&recordId=${contract.id}`)
    ).json<AuditPage>();

    expect(page.items.map((entry) => [entry.action, entry.actor?.name])).toEqual([
      ['update', 'Anil Owner'],
      ['update', 'Anil Owner'],
      ['insert', 'Staff branch_manager'],
    ]);
    expect(page.items[0]).toMatchObject({
      area: 'Contracts',
      recordLabel: `${contract.number} · Annual rate contract`,
    });
    expect(page.items[0]?.changes.map((c) => [c.label, c.oldText, c.newText])).toEqual([
      ['End date', contract.endDate, addDays(contract.endDate, 30)],
      ['Renewal date', contract.renewalDate, addDays(contract.renewalDate, 30)],
      ['Value', '₹10,000.00', '₹12,000.00'],
    ]);
    expect(page.items[1]?.changes.map((c) => [c.label, c.oldText, c.newText])).toEqual([
      ['Status', 'draft', 'active'],
    ]);
  });
});
