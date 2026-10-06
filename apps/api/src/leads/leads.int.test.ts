import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Lead {
  id: string;
  number: string;
  store: { code: string };
  party: { id: string; name: string; phone: string | null };
  title: string;
  source: string;
  referredBy: { id: string; name: string } | null;
  estimatedValuePaise: number | null;
  expectedOrderDate: string | null;
  assignedTo: { memberId: string; name: string };
  stage: string;
  lostReason: string | null;
  opportunityId: string | null;
  closedAt: string | null;
}
interface Opportunity {
  id: string;
  number: string;
  party: { id: string };
  lead: { id: string; number: string } | null;
  title: string;
  expectedValuePaise: number;
  weightedValuePaise: number;
  expectedQuantity: number | null;
  expectedOrderDate: string | null;
  category: { id: string; name: string } | null;
  salesperson: { memberId: string; name: string };
  probability: number;
  stage: string;
  lostReason: string | null;
  closedAt: string | null;
}
type Response = Awaited<ReturnType<ReturnType<typeof api>['post']>>;

let database: TestDatabase;
let t: TestApp;
let owner: string;
let sales: string;
let punSales: string;
let cashier: string;
let hyd: string;
let pune: string;
let contractor: string;
let architect: string;
let puneCustomer: string;
let category: string;
const members: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
});
const message = (response: Response) => response.json<{ message: string }>().message;
const issues = (response: Response) =>
  response.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path);

async function signup(name: string): Promise<string> {
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
  return response.json<{ token: string }>().token;
}

async function hire(key: string, roleKey: string, storeIds: string[], name: string) {
  const roles = (await api(owner).get('/roles')).json<{ id: string; key: string }[]>();
  const phone = uniquePhone();
  members[key] = (
    await api(owner).post('/members', {
      fullName: name,
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === roleKey)?.id,
      storeIds,
    })
  ).json<{ id: string }>().id;
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

const idOf = async (response: Promise<Response>) => (await response).json<{ id: string }>().id;

function newLead(overrides: object = {}, token = sales) {
  return api(token).post('/leads', {
    storeId: hyd,
    partyId: contractor,
    title: '4-floor building, Kondapur',
    source: 'phone_call',
    ...overrides,
  });
}

async function qualifiedLead(overrides: object = {}): Promise<Lead> {
  const lead = (await newLead(overrides)).json<Lead>();
  await api(sales).post(`/leads/${lead.id}/stage`, { stage: 'qualified' });
  return lead;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  owner = await signup('ABC Paints');
  hyd = await idOf(api(owner).post('/stores', { name: 'Hyderabad', code: 'HYD' }));
  pune = await idOf(api(owner).post('/stores', { name: 'Pune', code: 'PUN' }));
  sales = await hire('sales', 'sales_executive', [hyd], 'Ravi Sales');
  await hire('sales2', 'sales_executive', [hyd], 'Anita Sales');
  punSales = await hire('punSales', 'sales_executive', [pune], 'Pune Sales');
  cashier = await hire('cashier', 'store_employee', [hyd], 'Cashier');
  await hire('stockman', 'inventory_manager', [hyd], 'Stock Lead');
  contractor = await idOf(
    api(owner).post('/parties', {
      kind: 'organization',
      displayName: 'Sharma Builders',
      roles: ['contractor'],
    }),
  );
  architect = await idOf(
    api(owner).post('/parties', { displayName: 'Ar. Meera Rao', roles: ['architect'] }),
  );
  puneCustomer = await idOf(
    api(owner).post('/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: pune,
      roles: ['customer'],
    }),
  );
  category = await idOf(api(owner).post('/categories', { name: 'Exterior emulsions' }));
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('capturing leads', () => {
  it('adds a walk-in from a name and number, reusing the party next time', async () => {
    const phone = uniquePhone();
    const first = await newLead({
      partyId: undefined,
      contact: { displayName: 'Suresh Reddy', phone: phone.slice(3) },
      source: 'walk_in',
      title: 'Repaint 3BHK',
      requirement: 'Interior, about 1,800 sq ft',
      referredByPartyId: architect,
      estimatedValuePaise: 6_500_000,
      expectedOrderDate: '2026-11-15',
    });
    const second = await newLead({
      partyId: undefined,
      contact: { displayName: 'S. Reddy', phone },
      title: 'Compound wall',
    });

    expect(first.statusCode).toBe(201);
    const lead = first.json<Lead>();
    expect(lead).toMatchObject({
      store: { code: 'HYD' },
      party: { name: 'Suresh Reddy', phone },
      title: 'Repaint 3BHK',
      source: 'walk_in',
      referredBy: { id: architect, name: 'Ar. Meera Rao' },
      estimatedValuePaise: 6_500_000,
      expectedOrderDate: '2026-11-15',
      assignedTo: { memberId: members.sales, name: 'Ravi Sales' },
      stage: 'new',
      opportunityId: null,
    });
    expect(lead.number).toMatch(/^LD-\d{6}$/);
    expect(second.json<Lead>().party.id).toBe(lead.party.id);
    const party = (await api(owner).get(`/parties/${lead.party.id}`)).json<{
      roles: string[];
      homeStoreId: string;
      customer: { customerType: string } | null;
    }>();
    expect(party).toMatchObject({
      roles: ['customer'],
      homeStoreId: hyd,
      customer: { customerType: 'retail' },
    });
  });

  it('refuses what it cannot link, and people without permission', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const responses = await Promise.all([
      newLead({ storeId: ghost }),
      newLead({ storeId: pune }),
      newLead({ partyId: ghost }),
      newLead({ partyId: puneCustomer }),
      newLead({ referredByPartyId: ghost }),
      newLead({ assignedMemberId: members.punSales }),
      newLead({ assignedMemberId: members.stockman }),
    ]);

    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [404, 'Store not found'],
      [404, 'Store not found'],
      [400, 'Unknown party'],
      [400, 'Unknown party'],
      [400, 'Unknown referrer'],
      [400, 'Choose someone who works at this store and handles leads'],
      [400, 'Choose someone who works at this store and handles leads'],
    ]);
    expect((await newLead({}, cashier)).statusCode).toBe(403);
    expect((await api(cashier).get('/leads')).statusCode).toBe(403);
  });

  it.each([
    [{ contact: { displayName: 'Both', phone: '9876543210' } }, 'partyId'],
    [{ partyId: undefined }, 'partyId'],
    [{ source: 'billboard' }, 'source'],
    [{ title: 'ab' }, 'title'],
    [{ estimatedValuePaise: -1 }, 'estimatedValuePaise'],
    [{ expectedOrderDate: '15-11-2026' }, 'expectedOrderDate'],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await newLead(overrides);

    expect(response.statusCode).toBe(400);
    expect(issues(response)).toContain(field);
  });
});

describe('the pipeline', () => {
  it('takes a lead from new to won through an opportunity', async () => {
    const lead = (await newLead({ estimatedValuePaise: 85_000_000 })).json<Lead>();

    const contacted = (
      await api(sales).post(`/leads/${lead.id}/stage`, { stage: 'contacted' })
    ).json<Lead>();
    const qualified = (
      await api(sales).post(`/leads/${lead.id}/stage`, { stage: 'qualified' })
    ).json<Lead>();
    const converted = await api(sales).post(`/leads/${lead.id}/convert`, {
      expectedValuePaise: 85_000_000,
      expectedQuantity: 1_200,
      expectedOrderDate: '2026-11-30',
      categoryId: category,
    });
    const opportunity = converted.json<Opportunity>();
    const afterConvert = (await api(sales).get(`/leads/${lead.id}`)).json<Lead>();
    const proposal = (
      await api(sales).post(`/opportunities/${opportunity.id}/stage`, { stage: 'proposal' })
    ).json<Opportunity>();
    const negotiation = (
      await api(sales).post(`/opportunities/${opportunity.id}/stage`, {
        stage: 'negotiation',
        probability: 80,
      })
    ).json<Opportunity>();
    const won = (await api(sales).post(`/opportunities/${opportunity.id}/win`)).json<Opportunity>();
    const leadAfterWin = (await api(sales).get(`/leads/${lead.id}`)).json<Lead>();

    expect([contacted.stage, qualified.stage]).toEqual(['contacted', 'qualified']);
    expect(converted.statusCode).toBe(201);
    expect(opportunity).toMatchObject({
      party: { id: contractor },
      lead: { id: lead.id, number: lead.number },
      title: '4-floor building, Kondapur',
      expectedValuePaise: 85_000_000,
      weightedValuePaise: 17_000_000,
      expectedQuantity: 1_200,
      expectedOrderDate: '2026-11-30',
      category: { id: category, name: 'Exterior emulsions' },
      salesperson: { memberId: members.sales, name: 'Ravi Sales' },
      probability: 20,
      stage: 'discovery',
    });
    expect(opportunity.number).toMatch(/^OP-\d{6}$/);
    expect(afterConvert).toMatchObject({ stage: 'opportunity', opportunityId: opportunity.id });
    expect([proposal.probability, negotiation.probability, negotiation.weightedValuePaise]).toEqual(
      [50, 80, 68_000_000],
    );
    expect(won).toMatchObject({ stage: 'won', probability: 100, closedAt: expect.any(String) });
    expect(leadAfterWin).toMatchObject({ stage: 'won', closedAt: expect.any(String) });
  });

  it('loses and reopens leads, and closes a lead with its lost opportunity', async () => {
    const lead = (await newLead()).json<Lead>();
    const lost = await api(sales).post(`/leads/${lead.id}/lose`, {
      reason: 'Chose another dealer',
    });
    const reopened = await api(sales).post(`/leads/${lead.id}/reopen`);
    const noReason = await api(sales).post(`/leads/${lead.id}/lose`, {});

    const viaOpportunity = await qualifiedLead();
    const opportunity = (
      await api(sales).post(`/leads/${viaOpportunity.id}/convert`, {
        title: 'Kondapur tower',
        expectedValuePaise: 1,
        salespersonMemberId: members.sales2,
      })
    ).json<Opportunity>();
    const lostOpportunity = await api(sales).post(`/opportunities/${opportunity.id}/lose`, {
      reason: 'Price too high',
    });
    const leadAfter = (await api(sales).get(`/leads/${viaOpportunity.id}`)).json<Lead>();
    const reopenRefused = await api(sales).post(`/leads/${viaOpportunity.id}/reopen`);

    expect(lost.json<Lead>()).toMatchObject({ stage: 'lost', lostReason: 'Chose another dealer' });
    expect(reopened.json<Lead>()).toMatchObject({
      stage: 'contacted',
      lostReason: null,
      closedAt: null,
    });
    expect(noReason.statusCode).toBe(400);
    expect(opportunity.title).toBe('Kondapur tower');
    expect(opportunity.salesperson.memberId).toBe(members.sales2);
    expect(lostOpportunity.json<Opportunity>()).toMatchObject({
      stage: 'lost',
      probability: 0,
      lostReason: 'Price too high',
    });
    expect(leadAfter).toMatchObject({ stage: 'lost', lostReason: 'Price too high' });
    expect([reopenRefused.statusCode, message(reopenRefused)]).toEqual([
      409,
      'Its opportunity was lost; start a new opportunity instead',
    ]);
  });

  it('allows only the moves that make sense', async () => {
    const fresh = (await newLead()).json<Lead>();
    const qualified = await qualifiedLead();
    const won = await api(sales).post(`/leads/${qualified.id}/win`);

    const responses = await Promise.all([
      api(sales).post(`/leads/${fresh.id}/win`),
      api(sales).post(`/leads/${fresh.id}/convert`, { expectedValuePaise: 1 }),
      api(sales).post(`/leads/${fresh.id}/reopen`),
      api(sales).patch(`/leads/${qualified.id}`, { title: 'Too late to edit' }),
      api(sales).post(`/leads/${qualified.id}/assign`, { memberId: members.sales2 }),
      api(sales).post(`/leads/${qualified.id}/stage`, { stage: 'new' }),
    ]);

    expect(won.json<Lead>()).toMatchObject({ stage: 'won', closedAt: expect.any(String) });
    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [409, 'This lead is new'],
      [409, 'This lead is new'],
      [409, 'This lead is new'],
      [409, 'This lead is won'],
      [409, 'This lead is won'],
      [409, 'This lead is won'],
    ]);
    expect((await api(sales).post(`/leads/${fresh.id}/stage`, { stage: 'won' })).statusCode).toBe(
      400,
    );
  });

  it('edits and reassigns open leads and opportunities', async () => {
    const lead = (
      await newLead({ referredByPartyId: architect, requirement: 'Exterior' })
    ).json<Lead>();

    const edited = (
      await api(sales).patch(`/leads/${lead.id}`, {
        title: 'Kondapur tower, 6 floors',
        requirement: null,
        referredByPartyId: null,
        estimatedValuePaise: 120_000_000,
        source: 'referral',
      })
    ).json<Lead>();
    const reReferred = await api(sales).patch(`/leads/${lead.id}`, {
      referredByPartyId: contractor,
    });
    const badReferrer = await api(sales).patch(`/leads/${lead.id}`, {
      referredByPartyId: puneCustomer,
    });
    const reassigned = (
      await api(sales).post(`/leads/${lead.id}/assign`, { memberId: members.sales2 })
    ).json<Lead>();
    const wrongStore = await api(sales).post(`/leads/${lead.id}/assign`, {
      memberId: members.punSales,
    });
    const nothing = await api(sales).patch(`/leads/${lead.id}`, {});

    expect(edited).toMatchObject({
      title: 'Kondapur tower, 6 floors',
      referredBy: null,
      estimatedValuePaise: 120_000_000,
      source: 'referral',
    });
    expect(reReferred.json<Lead>().referredBy?.id).toBe(contractor);
    expect(message(badReferrer)).toBe('Unknown referrer');
    expect(reassigned.assignedTo).toEqual({ memberId: members.sales2, name: 'Anita Sales' });
    expect(wrongStore.statusCode).toBe(400);
    expect(nothing.statusCode).toBe(400);

    await api(sales).post(`/leads/${lead.id}/stage`, { stage: 'qualified' });
    const opportunity = (
      await api(sales).post(`/leads/${lead.id}/convert`, { expectedValuePaise: 5 })
    ).json<Opportunity>();
    // Defaults to the lead's assignee.
    expect(opportunity.salesperson.memberId).toBe(members.sales2);
    const moved = (
      await api(sales).post(`/opportunities/${opportunity.id}/assign`, { memberId: members.sales })
    ).json<Opportunity>();
    const changed = (
      await api(sales).patch(`/opportunities/${opportunity.id}`, {
        title: 'Kondapur tower order',
        expectedValuePaise: 90_000_000,
        expectedQuantity: 1500.5,
        expectedOrderDate: '2026-12-01',
        categoryId: category,
        probability: 35,
      })
    ).json<Opportunity>();
    const cleared = (
      await api(sales).patch(`/opportunities/${opportunity.id}`, {
        expectedQuantity: null,
        expectedOrderDate: null,
        categoryId: null,
      })
    ).json<Opportunity>();
    const badCategory = await api(sales).patch(`/opportunities/${opportunity.id}`, {
      categoryId: '00000000-0000-4000-8000-000000000000',
    });

    expect(moved.salesperson.memberId).toBe(members.sales);
    expect(changed).toMatchObject({
      expectedQuantity: 1500.5,
      probability: 35,
      weightedValuePaise: 31_500_000,
    });
    expect(cleared).toMatchObject({
      expectedQuantity: null,
      expectedOrderDate: null,
      category: null,
    });
    expect(message(badCategory)).toBe('Unknown category');
    // A converted lead can still be handed to someone else.
    expect(
      (await api(sales).post(`/leads/${lead.id}/assign`, { memberId: members.sales })).statusCode,
    ).toBe(200);

    await api(sales).post(`/opportunities/${opportunity.id}/win`);
    const responses = await Promise.all([
      api(sales).patch(`/opportunities/${opportunity.id}`, { probability: 10 }),
      api(sales).post(`/opportunities/${opportunity.id}/assign`, { memberId: members.sales2 }),
      api(sales).post(`/opportunities/${opportunity.id}/lose`, { reason: 'Changed mind' }),
    ]);
    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [409, 'This opportunity is won'],
      [409, 'This opportunity is won'],
      [409, 'This opportunity is won'],
    ]);
  });
});

describe('opportunities without a lead', () => {
  it('creates one directly, checking store, customer, category and salesperson', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    const body = {
      storeId: hyd,
      partyId: contractor,
      title: 'Annual maintenance',
      expectedValuePaise: 2_000_000,
    };

    const created = await api(sales).post('/opportunities', { ...body, probability: 60 });
    const responses = await Promise.all([
      api(sales).post('/opportunities', { ...body, storeId: pune }),
      api(sales).post('/opportunities', { ...body, partyId: puneCustomer }),
      api(sales).post('/opportunities', { ...body, categoryId: ghost }),
      api(sales).post('/opportunities', { ...body, salespersonMemberId: members.cashier }),
      api(sales).post('/opportunities', { ...body, probability: 101 }),
    ]);

    expect(created.statusCode).toBe(201);
    expect(created.json<Opportunity>()).toMatchObject({
      lead: null,
      probability: 60,
      salesperson: { memberId: members.sales },
      category: null,
    });
    expect(responses.map((r) => r.statusCode)).toEqual([404, 400, 400, 400, 400]);
    expect((await api(sales).get(`/opportunities/${ghost}`)).statusCode).toBe(404);
    // Winning one without a lead touches no lead.
    const won = await api(sales).post(`/opportunities/${created.json<Opportunity>().id}/win`);
    expect(won.json<Opportunity>()).toMatchObject({ stage: 'won', lead: null });
    expect((await api(sales).post(`/opportunities/${ghost}/win`)).statusCode).toBe(404);
    const punOpportunity = (
      await api(punSales).post('/opportunities', { ...body, storeId: pune, partyId: puneCustomer })
    ).json<Opportunity>();
    expect((await api(sales).post(`/opportunities/${punOpportunity.id}/win`)).statusCode).toBe(404);
    expect((await api(sales).get(`/opportunities/${punOpportunity.id}`)).statusCode).toBe(404);
  });
});

describe('lists and boards', () => {
  it('filters leads by stage, source, assignee and text, within the member’s stores', async () => {
    const punLead = (
      await newLead({ storeId: pune, partyId: puneCustomer, title: 'Pune villa' }, punSales)
    ).json<Lead>();
    const mine = (
      await newLead({ title: 'Searchable Gachibowli job', source: 'exhibition' })
    ).json<Lead>();

    const bySource = (await api(sales).get('/leads?source=exhibition')).json<{
      items: Lead[];
      total: number;
    }>();
    const byText = (await api(sales).get('/leads?q=gachibowli')).json<{ items: Lead[] }>();
    const byNumber = (await api(sales).get(`/leads?q=${mine.number}`)).json<{ items: Lead[] }>();
    const byParty = (await api(owner).get('/leads?q=pune customer')).json<{ items: Lead[] }>();
    const assignedToMe = (await api(sales).get('/leads?assignedTo=me&stage=new&limit=200')).json<{
      items: Lead[];
    }>();
    const assignedTo2 = (await api(owner).get(`/leads?assignedTo=${String(members.sales2)}`)).json<{
      items: Lead[];
    }>();
    const ownerAtPune = (await api(owner).get(`/leads?storeId=${pune}`)).json<{
      items: Lead[];
      total: number;
    }>();

    expect(bySource).toMatchObject({ total: 1, items: [{ id: mine.id }] });
    expect(byText.items.map((l) => l.id)).toEqual([mine.id]);
    expect(byNumber.items.map((l) => l.id)).toEqual([mine.id]);
    expect(byParty.items.map((l) => l.id)).toEqual([punLead.id]);
    expect(
      assignedToMe.items.every((l) => l.assignedTo.memberId === members.sales && l.stage === 'new'),
    ).toBe(true);
    expect(assignedTo2.items.every((l) => l.assignedTo.memberId === members.sales2)).toBe(true);
    expect(ownerAtPune).toMatchObject({ total: 1, items: [{ id: punLead.id }] });
    expect(
      (await api(sales).get('/leads?limit=200')).json<{ items: Lead[] }>().items.map((l) => l.id),
    ).not.toContain(punLead.id);
    expect((await api(sales).get(`/leads?storeId=${pune}`)).statusCode).toBe(404);
    expect((await api(sales).get(`/leads/${punLead.id}`)).statusCode).toBe(404);
    expect(
      (await api(sales).post(`/leads/${punLead.id}/stage`, { stage: 'contacted' })).statusCode,
    ).toBe(404);
  });

  it('totals leads and opportunities per stage for kanban columns', async () => {
    const owners = await signup('Board Paints');
    const store = await idOf(api(owners).post('/stores', { name: 'Board', code: 'BRD' }));
    const party = await idOf(
      api(owners).post('/parties', { displayName: 'Board Party', roles: ['customer'] }),
    );
    const lead = (
      await api(owners).post('/leads', {
        storeId: store,
        partyId: party,
        title: 'One',
        source: 'website',
        estimatedValuePaise: 100,
      })
    ).json<Lead>();
    await api(owners).post('/leads', {
      storeId: store,
      partyId: party,
      title: 'Two',
      source: 'website',
      estimatedValuePaise: 250,
    });
    await api(owners).post('/leads', {
      storeId: store,
      partyId: party,
      title: 'Three',
      source: 'website',
    });
    await api(owners).post(`/leads/${lead.id}/stage`, { stage: 'qualified' });
    const opportunity = (
      await api(owners).post(`/leads/${lead.id}/convert`, {
        expectedValuePaise: 1_000,
        probability: 30,
      })
    ).json<Opportunity>();
    await api(owners).post('/opportunities', {
      storeId: store,
      partyId: party,
      title: 'Direct',
      expectedValuePaise: 500,
    });
    await api(owners).post(`/opportunities/${opportunity.id}/stage`, {
      stage: 'proposal',
      probability: 40,
    });

    const leadBoard = (await api(owners).get('/leads/pipeline')).json<
      { stage: string; count: number; valuePaise: number }[]
    >();
    const opportunityBoard = (
      await api(owners).get(`/opportunities/pipeline?storeId=${store}&assignedTo=me`)
    ).json<{ stage: string; count: number; valuePaise: number; weightedValuePaise: number }[]>();
    const opportunityList = (await api(owners).get('/opportunities?stage=proposal&q=one')).json<{
      items: Opportunity[];
      total: number;
    }>();

    expect(leadBoard).toEqual([
      { stage: 'new', count: 2, valuePaise: 250 },
      { stage: 'contacted', count: 0, valuePaise: 0 },
      { stage: 'qualified', count: 0, valuePaise: 0 },
      { stage: 'opportunity', count: 1, valuePaise: 100 },
      { stage: 'won', count: 0, valuePaise: 0 },
      { stage: 'lost', count: 0, valuePaise: 0 },
    ]);
    expect(opportunityBoard).toEqual([
      { stage: 'discovery', count: 1, valuePaise: 500, weightedValuePaise: 100 },
      { stage: 'proposal', count: 1, valuePaise: 1_000, weightedValuePaise: 400 },
      { stage: 'negotiation', count: 0, valuePaise: 0, weightedValuePaise: 0 },
      { stage: 'won', count: 0, valuePaise: 0, weightedValuePaise: 0 },
      { stage: 'lost', count: 0, valuePaise: 0, weightedValuePaise: 0 },
    ]);
    expect(opportunityList).toMatchObject({ total: 1, items: [{ id: opportunity.id }] });
    expect(
      (await api(owners).get(`/opportunities?storeId=${store}&assignedTo=me&limit=1`)).json<{
        total: number;
      }>().total,
    ).toBe(2);
  });

  it('lists one party’s leads and opportunities, for the customer 360', async () => {
    const owners = await signup('Party Paints');
    const store = await idOf(api(owners).post('/stores', { name: 'Party', code: 'PTY' }));
    const party = (name: string) =>
      idOf(api(owners).post('/parties', { displayName: name, roles: ['customer'] }));
    const mine = await party('Mine');
    const theirs = await party('Theirs');
    const lead = (partyId: string, title: string) =>
      idOf(api(owners).post('/leads', { storeId: store, partyId, title, source: 'website' }));
    const opportunity = (partyId: string, title: string) =>
      idOf(
        api(owners).post('/opportunities', {
          storeId: store,
          partyId,
          title,
          expectedValuePaise: 1,
        }),
      );
    const myLead = await lead(mine, 'My lead');
    await lead(theirs, 'Their lead');
    const myOpportunity = await opportunity(mine, 'My order');
    await opportunity(theirs, 'Their order');
    const list = async (url: string) =>
      (await api(owners).get(url)).json<{ items: { id: string }[]; total: number }>();

    expect(await list(`/leads?partyId=${mine}`)).toMatchObject({
      total: 1,
      items: [{ id: myLead }],
    });
    expect(await list(`/opportunities?partyId=${mine}`)).toMatchObject({
      total: 1,
      items: [{ id: myOpportunity }],
    });
    // Another business's party matches nothing here.
    expect((await list(`/leads?partyId=${puneCustomer}`)).total).toBe(0);
    expect((await api(owners).get('/leads?partyId=nobody')).statusCode).toBe(400);
  });
});

describe('races', () => {
  /** Holds a row lock so both requests queue, then releases it once both wait. */
  async function whileLocked<T>(table: string, id: string, race: () => Promise<T>): Promise<T> {
    const blocker = new pg.Client({ connectionString: database.connectionString });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const racing = race();
      await vi.waitFor(
        async () => {
          const waiting = await withPgClient(database.connectionString, (client) =>
            client.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            ),
          );
          expect((waiting.rows[0] as { n: number }).n).toBe(2);
        },
        { timeout: 10_000, interval: 50 },
      );
      await blocker.query('ROLLBACK');
      return await racing;
    } finally {
      await blocker.end();
    }
  }

  it('converts a lead only once when two people click at the same moment', async () => {
    const lead = await qualifiedLead();

    const results = await whileLocked('leads', lead.id, () =>
      Promise.all([
        api(sales).post(`/leads/${lead.id}/convert`, { expectedValuePaise: 1 }),
        api(owner).post(`/leads/${lead.id}/convert`, { expectedValuePaise: 2 }),
      ]),
    );

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    // The second waits for the first, then finds the lead already converted.
    expect(results.find((r) => r.statusCode === 409)?.json<{ message: string }>().message).toBe(
      'This lead is opportunity',
    );
  });

  it('closes an opportunity only once', async () => {
    const lead = await qualifiedLead();
    const opportunity = (
      await api(sales).post(`/leads/${lead.id}/convert`, { expectedValuePaise: 1 })
    ).json<Opportunity>();

    const results = await whileLocked('opportunities', opportunity.id, () =>
      Promise.all([
        api(sales).post(`/opportunities/${opportunity.id}/win`),
        api(owner).post(`/opportunities/${opportunity.id}/lose`, { reason: 'Same moment' }),
      ]),
    );

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json<{ message: string }>().message).toMatch(
      /^This opportunity is (won|lost)$/,
    );
  });
});
