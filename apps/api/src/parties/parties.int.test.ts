import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Party {
  id: string;
  displayName: string;
  phone: string | null;
  gstin: string | null;
  pan: string | null;
  legalName: string | null;
  homeStoreId: string | null;
  tags: string[];
  isActive: boolean;
  roles: string[];
  customer: {
    customerType: string;
    assignedMemberId: string | null;
    preferredContact: string;
  } | null;
}
interface Page {
  items: Party[];
  total: number;
}

const GSTIN_A = '27AAPFU0939F1ZV';
const GSTIN_B = '29AAGCB7383J1Z4';

let database: TestDatabase;
let t: TestApp;
let owner: string;
let organizationId: string;
let hyd: string;
let pune: string;
let hydManager: string;
let hydEmployee: string;
let salespersonId: string;

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});

async function signup(name: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      organizationName: name,
      fullName: 'Owner',
      phone: uniquePhone(),
      password: 'Staff@2026',
    },
  });
  return response.json<{ token: string; organizationId: string }>();
}

async function hire(roleKey: string, storeIds: string[]) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  const member = await api(owner).post('/members', {
    fullName: roleKey,
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

/** Creates a party as the owner (or another token) and returns it. */
async function party(payload: object, token = owner): Promise<Party> {
  const response = await api(token).post('/parties', { roles: ['customer'], ...payload });
  expect(response.statusCode).toBe(201);
  return response.json<Party>();
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  ({ token: owner, organizationId } = await signup('ABC Paints'));
  hyd = (await api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' })).json<{
    id: string;
  }>().id;
  pune = (await api(owner).post('/stores', { name: 'Pune', code: 'PUN' })).json<{ id: string }>()
    .id;
  hydManager = (await hire('branch_manager', [hyd])).token;
  hydEmployee = (await hire('store_employee', [hyd])).token;
  salespersonId = (await hire('sales_executive', [hyd])).memberId;
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('POST /parties', () => {
  it('creates one record with several roles, normalising what was typed', async () => {
    const phone = uniquePhone();
    const response = await api(owner).post('/parties', {
      displayName: 'Raj Kumar',
      phone: phone.slice(3),
      gstin: GSTIN_A.toLowerCase(),
      homeStoreId: hyd,
      tags: ['VIP', 'vip', ' Contractor '],
      roles: ['customer', 'contractor', 'painter', 'customer'],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      displayName: 'Raj Kumar',
      kind: 'person',
      phone,
      gstin: GSTIN_A,
      pan: 'AAPFU0939F',
      homeStoreId: hyd,
      tags: ['vip', 'contractor'],
      roles: ['contractor', 'customer', 'painter'],
      customer: { customerType: 'retail', assignedMemberId: null, preferredContact: 'phone' },
      isActive: true,
    });
  });

  it('saves customer details, including the assigned salesperson', async () => {
    const created = await party({
      displayName: 'Sai Builders',
      kind: 'organization',
      contactPerson: 'Sai',
      customer: {
        customerType: 'builder',
        preferredContact: 'whatsapp',
        assignedMemberId: salespersonId,
      },
    });

    expect(created.customer).toEqual({
      customerType: 'builder',
      preferredContact: 'whatsapp',
      assignedMemberId: salespersonId,
    });
  });

  it('keeps suppliers without a home store business-wide, with no customer details', async () => {
    const supplier = await party({ displayName: 'Asian Paints Depot', roles: ['supplier'] });

    expect(supplier.homeStoreId).toBeNull();
    expect(supplier.customer).toBeNull();
  });

  it('refuses a duplicate mobile number, pointing at the existing party', async () => {
    const phone = uniquePhone();
    const first = await party({ displayName: 'First', phone });

    const response = await api(owner).post('/parties', {
      displayName: 'Second',
      phone,
      roles: ['painter'],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      message: 'A party with this mobile number already exists',
      field: 'phone',
      existingPartyId: first.id,
    });
  });

  it('refuses a duplicate GSTIN, pointing at the existing party', async () => {
    const first = await party({ displayName: 'GST Holder', gstin: GSTIN_B, roles: ['dealer'] });

    const response = await api(owner).post('/parties', {
      displayName: 'Copycat',
      gstin: GSTIN_B,
      roles: ['dealer'],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ field: 'gstin', existingPartyId: first.id });
  });

  it.each([
    [{ gstin: '27AAPFU0939F1ZW' }, 'gstin'],
    [{ pan: 'AAPF0939F' }, 'pan'],
    [{ pincode: '050081' }, 'pincode'],
    [{ roles: [] }, 'roles'],
    [{ roles: ['plumber'] }, 'roles.0'],
    [{ displayName: 'A' }, 'displayName'],
    [{ roles: ['supplier'], customer: { customerType: 'retail' } }, 'customer'],
    [{ tags: ['x'.repeat(31)] }, 'tags.0'],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await api(owner).post('/parties', {
      displayName: 'Valid Name',
      roles: ['customer'],
      ...overrides,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues.map((i) => i.path)).toContain(
      field,
    );
  });

  it('refuses a PAN that contradicts the GSTIN', async () => {
    const response = await api(owner).post('/parties', {
      displayName: 'Mismatch',
      gstin: '27AAPFU0939F1ZV',
      pan: 'ABCDE1234F',
      roles: ['dealer'],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toBe('The PAN does not match the GSTIN');
  });

  it('accepts a PAN alone', async () => {
    const created = await party({ displayName: 'PAN Only', pan: 'abcde1234f' });

    expect(created.pan).toBe('ABCDE1234F');
  });

  it('refuses an unknown, inactive or foreign salesperson', async () => {
    const other = await signup('XYZ Paints');
    const otherMember = (await api(other.token).get('/members')).json<{ id: string }[]>()[0]?.id;

    for (const assignedMemberId of [otherMember, '00000000-0000-4000-8000-000000000000']) {
      const response = await api(owner).post('/parties', {
        displayName: 'Customer',
        roles: ['customer'],
        customer: { assignedMemberId },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ message: string }>().message).toBe('Unknown salesperson');
    }
  });

  it('refuses an unknown home store, and one the member cannot access', async () => {
    const unknown = await api(owner).post('/parties', {
      displayName: 'Nowhere',
      roles: ['customer'],
      homeStoreId: '00000000-0000-4000-8000-000000000000',
    });
    const forbidden = await api(hydManager).post('/parties', {
      displayName: 'Pune Customer',
      roles: ['customer'],
      homeStoreId: pune,
    });

    expect(unknown.statusCode).toBe(400);
    expect(forbidden.statusCode).toBe(403);
  });

  it('is not allowed for roles that can only read parties', async () => {
    const response = await api(hydEmployee).post('/parties', {
      displayName: 'Walk-in',
      roles: ['customer'],
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('GET /parties', () => {
  let list: Awaited<ReturnType<typeof seedDirectory>>;

  async function seedDirectory() {
    const { token } = await signup('Directory Paints');
    const store = (await api(token).post('/stores', { name: 'Main', code: 'MAIN' })).json<{
      id: string;
    }>().id;
    const make = (payload: object) =>
      api(token).post('/parties', { roles: ['customer'], homeStoreId: store, ...payload });
    await make({ displayName: 'Raj Kumar', phone: '9848012345' });
    await make({ displayName: 'raju painter', roles: ['painter'], phone: '9848099999' });
    await make({ displayName: 'Anand Hardware', roles: ['dealer'], gstin: GSTIN_A });
    await make({ displayName: 'Zeenat Interiors', roles: ['architect'] });
    await make({ displayName: '50% Off Paints', roles: ['supplier'] });
    const inactive = (await make({ displayName: 'Old Customer' })).json<{ id: string }>().id;
    await api(token).patch(`/parties/${inactive}`, { isActive: false });
    return { token };
  }

  beforeAll(async () => {
    list = await seedDirectory();
  });

  const names = async (query: string) =>
    (await api(list.token).get(`/parties${query}`)).json<Page>().items.map((p) => p.displayName);

  it('lists active parties by name, with a total', async () => {
    const page = (await api(list.token).get('/parties')).json<Page>();

    expect(page.items.map((p) => p.displayName)).toEqual([
      '50% Off Paints',
      'Anand Hardware',
      'Raj Kumar',
      'raju painter',
      'Zeenat Interiors',
    ]);
    expect(page.total).toBe(5);
  });

  it('filters by role', async () => {
    expect(await names('?role=painter')).toEqual(['raju painter']);
  });

  it.each([
    ['?q=RAJ', ['Raj Kumar', 'raju painter']],
    ['?q=98480', ['Raj Kumar', 'raju painter']],
    ['?q=12345', ['Raj Kumar']],
    ['?q=aapfu', ['Anand Hardware']],
    ['?q=50%25', ['50% Off Paints']],
    ['?q=%25', ['50% Off Paints']],
  ])('searches %s', async (query, expected) => {
    expect(await names(query)).toEqual(expected);
  });

  it('includes inactive parties only when asked', async () => {
    expect(await names('?includeInactive=true')).toContain('Old Customer');
    expect(await names('')).not.toContain('Old Customer');
  });

  it('pages through results', async () => {
    const page = (await api(list.token).get('/parties?limit=2&offset=2')).json<Page>();

    expect(page.items.map((p) => p.displayName)).toEqual(['Raj Kumar', 'raju painter']);
    expect(page.total).toBe(5);
  });

  it.each(['?limit=0', '?limit=500', '?offset=-1', '?role=plumber', '?includeInactive=yes'])(
    'answers 400 for %s',
    async (query) => {
      expect((await api(list.token).get(`/parties${query}`)).statusCode).toBe(400);
    },
  );
});

describe('store visibility', () => {
  let hydCustomer: Party;
  let puneCustomer: Party;
  let supplier: Party;

  beforeAll(async () => {
    hydCustomer = await party({ displayName: 'Hyderabad Customer', homeStoreId: hyd });
    puneCustomer = await party({ displayName: 'Pune Customer', homeStoreId: pune });
    supplier = await party({ displayName: 'Shared Supplier', roles: ['supplier'] });
  });

  it('shows Hyderabad staff their store’s parties and business-wide ones, not Pune’s', async () => {
    const ids = (await api(hydManager).get('/parties?limit=200'))
      .json<Page>()
      .items.map((p) => p.id);

    expect(ids).toContain(hydCustomer.id);
    expect(ids).toContain(supplier.id);
    expect(ids).not.toContain(puneCustomer.id);
  });

  it('answers 404 for a Pune party, for reading and for changing', async () => {
    expect((await api(hydManager).get(`/parties/${puneCustomer.id}`)).statusCode).toBe(404);
    expect(
      (await api(hydManager).patch(`/parties/${puneCustomer.id}`, { notes: 'hi' })).statusCode,
    ).toBe(404);
  });

  it('lets read-only staff view parties', async () => {
    expect((await api(hydEmployee).get(`/parties/${hydCustomer.id}`)).statusCode).toBe(200);
  });

  it('lets Hyderabad staff create parties for Hyderabad', async () => {
    const created = await party({ displayName: 'Walk-in Hyd', homeStoreId: hyd }, hydManager);

    expect(created.homeStoreId).toBe(hyd);
  });
});

describe('PATCH /parties/:id', () => {
  it('updates fields and clears optional ones with null', async () => {
    const created = await party({
      displayName: 'Before',
      legalName: 'Before Pvt Ltd',
      tags: ['a'],
    });

    const response = await api(owner).patch(`/parties/${created.id}`, {
      displayName: 'After',
      legalName: null,
      tags: ['New', 'new'],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ displayName: 'After', legalName: null, tags: ['new'] });
  });

  it('removes customer details with the customer role, and restores defaults when it is added back', async () => {
    const created = await party({
      displayName: 'Role Changer',
      customer: { customerType: 'corporate', preferredContact: 'email' },
    });

    const noLongerCustomer = (
      await api(owner).patch(`/parties/${created.id}`, { roles: ['supplier'] })
    ).json<Party>();
    const customerAgain = (
      await api(owner).patch(`/parties/${created.id}`, { roles: ['supplier', 'customer'] })
    ).json<Party>();

    expect(noLongerCustomer.customer).toBeNull();
    expect(customerAgain.customer).toEqual({
      customerType: 'retail',
      assignedMemberId: null,
      preferredContact: 'phone',
    });
  });

  it('merges customer detail changes with what is saved', async () => {
    const created = await party({
      displayName: 'Merge Me',
      customer: { customerType: 'contractor', preferredContact: 'whatsapp' },
    });

    const updated = (
      await api(owner).patch(`/parties/${created.id}`, {
        customer: { assignedMemberId: salespersonId },
      })
    ).json<Party>();

    expect(updated.customer).toEqual({
      customerType: 'contractor',
      preferredContact: 'whatsapp',
      assignedMemberId: salespersonId,
    });
  });

  it('refuses customer details for a party without the customer role', async () => {
    const supplier = await party({ displayName: 'Only Supplier', roles: ['supplier'] });

    const response = await api(owner).patch(`/parties/${supplier.id}`, {
      customer: { customerType: 'retail' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('keeps PAN in step with the GSTIN', async () => {
    const created = await party({ displayName: 'Tax Changer', roles: ['dealer'] });

    const withGstin = (
      await api(owner).patch(`/parties/${created.id}`, { gstin: '36aabcu9603r1zo' })
    ).json<Party>();
    const contradicting = await api(owner).patch(`/parties/${created.id}`, { pan: 'ABCDE1234F' });

    expect(withGstin.pan).toBe('AABCU9603R');
    expect(contradicting.statusCode).toBe(400);
  });

  it('refuses a duplicate mobile number', async () => {
    const phone = uniquePhone();
    const first = await party({ displayName: 'Has Number', phone });
    const second = await party({ displayName: 'Wants Number' });

    const response = await api(owner).patch(`/parties/${second.id}`, { phone });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ field: 'phone', existingPartyId: first.id });
  });

  it('moves a party between stores, within what the member can access', async () => {
    const created = await party({ displayName: 'Mover', homeStoreId: hyd });

    const byOwner = await api(owner).patch(`/parties/${created.id}`, { homeStoreId: pune });
    const byHydManager = await api(hydManager).patch(`/parties/${created.id}`, {
      homeStoreId: hyd,
    });

    expect(byOwner.json<Party>().homeStoreId).toBe(pune);
    expect(byHydManager.statusCode).toBe(404);
  });

  it('lets staff save a party without re-checking an unchanged home store', async () => {
    const created = await party({ displayName: 'Stays Put', homeStoreId: hyd }, hydManager);

    const response = await api(hydManager).patch(`/parties/${created.id}`, {
      homeStoreId: hyd,
      notes: 'Prefers morning delivery',
    });

    expect(response.statusCode).toBe(200);
  });

  it('stops staff moving a party to a store they cannot access', async () => {
    const created = await party({ displayName: 'Stuck', homeStoreId: hyd }, hydManager);

    const response = await api(hydManager).patch(`/parties/${created.id}`, { homeStoreId: pune });

    expect(response.statusCode).toBe(403);
  });

  it('answers 400 for an empty change or a bad id, and 404 for an unknown party', async () => {
    const created = await party({ displayName: 'Target' });

    expect((await api(owner).patch(`/parties/${created.id}`, {})).statusCode).toBe(400);
    expect((await api(owner).get('/parties/not-a-uuid')).statusCode).toBe(400);
    expect(
      (await api(owner).patch('/parties/00000000-0000-4000-8000-000000000000', { notes: 'x' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('another business', () => {
  it('cannot see or change ABC Paints’ parties', async () => {
    const created = await party({ displayName: 'Private Customer' });
    const rival = await signup('XYZ Paints');

    expect((await api(rival.token).get('/parties')).json<Page>().items).toEqual([]);
    expect((await api(rival.token).get(`/parties/${created.id}`)).statusCode).toBe(404);
    expect(organizationId).not.toBe(rival.organizationId);
  });
});

describe('without signing in', () => {
  it('answers 401', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/parties' })).statusCode).toBe(401);
  });
});
