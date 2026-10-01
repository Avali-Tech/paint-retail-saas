import { migrateDatabase } from '@paint/db';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { bearer, startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

interface Project {
  id: string;
  number: string;
  store: { code: string };
  name: string;
  customer: { id: string; name: string };
  opportunity: { id: string; number: string } | null;
  site: {
    addressLine: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  startDate: string | null;
  expectedCompletionDate: string | null;
  estimatedAreaSqFt: number | null;
  estimatedPaintLitres: number | null;
  expectedOrderValuePaise: number | null;
  stage: string;
  cancelReason: string | null;
  notes: string | null;
  assignedTo: { memberId: string; name: string };
  parties: { partyId: string; name: string; role: string }[];
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
const party: Record<string, string> = {};
const members: Record<string, string> = {};

const api = (token: string) => ({
  get: (url: string) => t.app.inject({ method: 'GET', url, headers: bearer(token) }),
  post: (url: string, payload: object = {}) =>
    t.app.inject({ method: 'POST', url, headers: bearer(token), payload }),
  patch: (url: string, payload: object) =>
    t.app.inject({ method: 'PATCH', url, headers: bearer(token), payload }),
  put: (url: string, payload: object) =>
    t.app.inject({ method: 'PUT', url, headers: bearer(token), payload }),
});
const message = (response: Response) => response.json<{ message: string }>().message;
const issues = (response: Response) =>
  response.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path);
const idOf = async (response: Promise<Response>) => (await response).json<{ id: string }>().id;

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
  members[key] = await idOf(
    api(owner).post('/members', {
      fullName: name,
      phone,
      password: 'Staff@2026',
      roleId: roles.find((role) => role.key === roleKey)?.id,
      storeIds,
    }),
  );
  const login = await t.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { identifier: phone, password: 'Staff@2026' },
  });
  return login.json<{ token: string }>().token;
}

const newProject = (overrides: object = {}, token = sales) =>
  api(token).post('/projects', {
    storeId: hyd,
    customerPartyId: party.customer,
    name: 'Gachibowli Heights',
    ...overrides,
  });

/** A lead taken to an opportunity with `fields`, returning the opportunity. */
async function opportunity(
  fields: object = { expectedValuePaise: 85_000_000, expectedQuantity: 1_800 },
) {
  const lead = (
    await api(sales).post('/leads', {
      storeId: hyd,
      partyId: party.customer,
      title: 'Gachibowli apartment block',
      source: 'architect',
    })
  ).json<{ id: string }>();
  await api(sales).post(`/leads/${lead.id}/stage`, { stage: 'qualified' });
  return (await api(sales).post(`/leads/${lead.id}/convert`, fields)).json<{
    id: string;
    number: string;
    title: string;
  }>();
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
  for (const [key, name, roles] of [
    ['customer', 'Sharma Builders', ['customer']],
    ['architect', 'Ar. Meera Rao', ['architect']],
    ['contractor', 'Kumar Contractors', ['contractor']],
    ['painter', 'Ramesh Painter', ['painter']],
    ['painter2', 'Akbar Painter', ['painter']],
    ['dealer', 'City Paints Dealer', ['dealer']],
  ] as const) {
    party[key] = await idOf(
      api(owner).post('/parties', { kind: 'organization', displayName: name, roles: [...roles] }),
    );
  }
  party.puneCustomer = await idOf(
    api(owner).post('/parties', {
      displayName: 'Pune Customer',
      phone: uniquePhone(),
      homeStoreId: pune,
      roles: ['customer'],
    }),
  );
});

afterAll(async () => {
  await t.close();
  await database.stop();
});

describe('projects', () => {
  it('records the site, the job and everyone working on it', async () => {
    const response = await newProject({
      addressLine: 'Plot 21, Financial District',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500032',
      latitude: 17.415123,
      longitude: 78.339456,
      startDate: '2026-11-01',
      expectedCompletionDate: '2027-02-28',
      estimatedAreaSqFt: 48_000,
      estimatedPaintLitres: 2_100.5,
      expectedOrderValuePaise: 95_000_000,
      notes: 'G+12, exterior and common areas',
      parties: [
        { partyId: party.painter, role: 'painter' },
        { partyId: party.architect, role: 'architect' },
        { partyId: party.painter2, role: 'painter' },
        { partyId: party.contractor, role: 'contractor' },
        { partyId: party.dealer, role: 'dealer' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const project = response.json<Project>();
    expect(project).toMatchObject({
      store: { code: 'HYD' },
      name: 'Gachibowli Heights',
      customer: { id: party.customer, name: 'Sharma Builders' },
      opportunity: null,
      site: {
        addressLine: 'Plot 21, Financial District',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500032',
        latitude: 17.415123,
        longitude: 78.339456,
      },
      startDate: '2026-11-01',
      expectedCompletionDate: '2027-02-28',
      estimatedAreaSqFt: 48_000,
      estimatedPaintLitres: 2_100.5,
      expectedOrderValuePaise: 95_000_000,
      stage: 'identified',
      assignedTo: { memberId: members.sales, name: 'Ravi Sales' },
    });
    expect(project.number).toMatch(/^PJ-\d{6}$/);
    expect(project.parties.map((p) => [p.role, p.name])).toEqual([
      ['architect', 'Ar. Meera Rao'],
      ['contractor', 'Kumar Contractors'],
      ['painter', 'Akbar Painter'],
      ['painter', 'Ramesh Painter'],
      ['dealer', 'City Paints Dealer'],
    ]);
  });

  it('refuses what it cannot link, and people without permission', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';

    const responses = await Promise.all([
      newProject({ storeId: pune }),
      newProject({ customerPartyId: ghost }),
      newProject({ customerPartyId: party.puneCustomer }),
      newProject({ parties: [{ partyId: party.puneCustomer, role: 'painter' }] }),
      newProject({ assignedMemberId: members.stockman }),
      newProject({ startDate: '2026-12-01', expectedCompletionDate: '2026-11-01' }),
    ]);

    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [404, 'Store not found'],
      [400, 'Unknown customer'],
      [400, 'Unknown customer'],
      [400, 'Unknown party'],
      [400, 'Choose someone who works at this store and handles projects'],
      [400, 'The expected completion cannot be before the start'],
    ]);
    expect((await newProject({}, cashier)).statusCode).toBe(403);
    expect((await api(cashier).get('/projects')).statusCode).toBe(403);
  });

  it.each([
    [{ latitude: 17.4 }, 'latitude'],
    [{ latitude: 95, longitude: 78 }, 'latitude'],
    [{ pincode: '5000' }, 'pincode'],
    [{ estimatedAreaSqFt: 0 }, 'estimatedAreaSqFt'],
    [{ estimatedPaintLitres: 1.0001 }, 'estimatedPaintLitres'],
    [
      {
        parties: [
          { partyId: '00000000-0000-4000-8000-000000000000', role: 'painter' },
          { partyId: '00000000-0000-4000-8000-000000000000', role: 'painter' },
        ],
      },
      'parties',
    ],
    [
      { parties: [{ partyId: '00000000-0000-4000-8000-000000000000', role: 'customer' }] },
      'parties.0.role',
    ],
  ])('answers 400 for %o', async (overrides, field) => {
    const response = await newProject(overrides);

    expect(response.statusCode).toBe(400);
    expect(issues(response)).toContain(field);
  });
});

describe('from an opportunity', () => {
  it('starts the project with the opportunity’s customer, value and paint, once', async () => {
    const source = await opportunity();

    const response = await api(sales).post(`/opportunities/${source.id}/project`, {
      city: 'Hyderabad',
    });
    const again = await api(sales).post(`/opportunities/${source.id}/project`);
    const opportunityAfter = (await api(sales).get(`/opportunities/${source.id}`)).json<{
      project: { id: string; number: string } | null;
    }>();

    expect(response.statusCode).toBe(201);
    const project = response.json<Project>();
    expect(project).toMatchObject({
      name: 'Gachibowli apartment block',
      customer: { id: party.customer },
      opportunity: { id: source.id, number: source.number },
      expectedOrderValuePaise: 85_000_000,
      estimatedPaintLitres: 1_800,
      site: { city: 'Hyderabad' },
      assignedTo: { memberId: members.sales },
    });
    expect(opportunityAfter.project).toEqual({ id: project.id, number: project.number });
    expect([again.statusCode, message(again)]).toEqual([
      409,
      `This opportunity already has project ${project.number}`,
    ]);
  });

  it('takes a name, figures and assignee from the request, and needs no quantity', async () => {
    const source = await opportunity({ expectedValuePaise: 1_000 });

    const project = (
      await api(sales).post(`/opportunities/${source.id}/project`, {
        name: 'Block B',
        expectedOrderValuePaise: 2_000,
        assignedMemberId: members.sales2,
      })
    ).json<Project>();

    expect(project).toMatchObject({
      name: 'Block B',
      expectedOrderValuePaise: 2_000,
      estimatedPaintLitres: null,
      assignedTo: { memberId: members.sales2 },
    });
  });

  it('refuses lost, missing and other stores’ opportunities', async () => {
    const lost = await opportunity({ expectedValuePaise: 1 });
    await api(sales).post(`/opportunities/${lost.id}/lose`, { reason: 'Went elsewhere' });
    const punOpportunity = await idOf(
      api(punSales).post('/opportunities', {
        storeId: pune,
        partyId: party.puneCustomer,
        title: 'Pune villa',
        expectedValuePaise: 1,
      }),
    );

    const responses = await Promise.all([
      api(sales).post(`/opportunities/${lost.id}/project`),
      api(sales).post('/opportunities/00000000-0000-4000-8000-000000000000/project'),
      api(sales).post(`/opportunities/${punOpportunity}/project`),
    ]);

    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [409, 'This opportunity is lost'],
      [404, 'Opportunity not found'],
      [404, 'Opportunity not found'],
    ]);
  });

  it('starts only one project when two people click at the same moment', async () => {
    const source = await opportunity({ expectedValuePaise: 1 });
    const blocker = new pg.Client({ connectionString: database.connectionString });
    await blocker.connect();
    let results: Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM opportunities WHERE id = $1 FOR UPDATE', [source.id]);
      const racing = Promise.all([
        api(sales).post(`/opportunities/${source.id}/project`),
        api(owner).post(`/opportunities/${source.id}/project`),
      ]);
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
      results = await racing;
    } finally {
      await blocker.end();
    }

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});

describe('working a project', () => {
  it('moves through every stage to completion, then stays closed', async () => {
    const project = (await newProject()).json<Project>();

    const stages: string[] = [];
    for (const stage of [
      'survey',
      'specification',
      'quotation',
      'negotiation',
      'order',
      'execution',
      'completed',
    ]) {
      stages.push(
        (await api(sales).post(`/projects/${project.id}/stage`, { stage })).json<Project>().stage,
      );
    }
    const done = (await api(sales).get(`/projects/${project.id}`)).json<Project>();
    const responses = await Promise.all([
      api(sales).patch(`/projects/${project.id}`, { notes: 'Too late' }),
      api(sales).post(`/projects/${project.id}/cancel`, { reason: 'Too late' }),
      api(sales).put(`/projects/${project.id}/parties`, { parties: [] }),
    ]);

    expect(stages).toEqual([
      'survey',
      'specification',
      'quotation',
      'negotiation',
      'order',
      'execution',
      'completed',
    ]);
    expect(done.closedAt).toEqual(expect.any(String));
    expect(responses.map((r) => [r.statusCode, message(r)])).toEqual([
      [409, 'This project is completed'],
      [409, 'This project is completed'],
      [409, 'This project is completed'],
    ]);
    expect(
      (await api(sales).post(`/projects/${project.id}/stage`, { stage: 'cancelled' })).statusCode,
    ).toBe(400);
  });

  it('cancels with a reason, and can go back a stage while open', async () => {
    const project = (await newProject()).json<Project>();
    await api(sales).post(`/projects/${project.id}/stage`, { stage: 'quotation' });
    const back = (
      await api(sales).post(`/projects/${project.id}/stage`, { stage: 'survey' })
    ).json<Project>();
    const cancelled = (
      await api(sales).post(`/projects/${project.id}/cancel`, {
        reason: 'Builder ran out of funds',
      })
    ).json<Project>();

    expect(back.stage).toBe('survey');
    expect(cancelled).toMatchObject({
      stage: 'cancelled',
      cancelReason: 'Builder ran out of funds',
      closedAt: expect.any(String),
    });
    expect(
      (await api(sales).post(`/projects/${project.id}/stage`, { stage: 'survey' })).statusCode,
    ).toBe(409);
  });

  it('edits details, replaces the people on it, and reassigns', async () => {
    const project = (
      await newProject({
        startDate: '2026-11-01',
        expectedCompletionDate: '2026-12-31',
        latitude: 17.1,
        longitude: 78.1,
        parties: [{ partyId: party.architect, role: 'architect' }],
      })
    ).json<Project>();

    const edited = (
      await api(sales).patch(`/projects/${project.id}`, {
        name: 'Gachibowli Heights, Phase 2',
        city: 'Hyderabad',
        latitude: null,
        longitude: null,
        estimatedPaintLitres: 950,
        notes: null,
      })
    ).json<Project>();
    const badDates = await api(sales).patch(`/projects/${project.id}`, { startDate: '2027-01-15' });
    const badEnd = await api(sales).patch(`/projects/${project.id}`, {
      expectedCompletionDate: '2026-10-01',
    });
    const cleared = await api(sales).patch(`/projects/${project.id}`, {
      startDate: null,
      expectedCompletionDate: '2026-10-01',
    });
    const halfPin = await api(sales).patch(`/projects/${project.id}`, { latitude: 17.2 });
    const relinked = (
      await api(sales).put(`/projects/${project.id}/parties`, {
        parties: [
          { partyId: party.contractor, role: 'contractor' },
          { partyId: party.contractor, role: 'painter' },
        ],
      })
    ).json<Project>();
    const unlinked = (
      await api(sales).put(`/projects/${project.id}/parties`, { parties: [] })
    ).json<Project>();
    const hidden = await api(sales).put(`/projects/${project.id}/parties`, {
      parties: [{ partyId: party.puneCustomer, role: 'dealer' }],
    });
    const reassigned = (
      await api(sales).post(`/projects/${project.id}/assign`, { memberId: members.sales2 })
    ).json<Project>();
    const wrongStore = await api(sales).post(`/projects/${project.id}/assign`, {
      memberId: members.punSales,
    });

    expect(edited).toMatchObject({
      name: 'Gachibowli Heights, Phase 2',
      site: { city: 'Hyderabad', latitude: null, longitude: null },
      estimatedPaintLitres: 950,
      notes: null,
    });
    expect([badDates.statusCode, message(badDates)]).toEqual([
      400,
      'The expected completion cannot be before the start',
    ]);
    expect(badEnd.statusCode).toBe(400);
    expect(cleared.json<Project>()).toMatchObject({
      startDate: null,
      expectedCompletionDate: '2026-10-01',
    });
    expect(issues(halfPin)).toContain('latitude');
    expect(relinked.parties.map((p) => [p.role, p.partyId])).toEqual([
      ['contractor', party.contractor],
      ['painter', party.contractor],
    ]);
    expect(unlinked.parties).toEqual([]);
    expect(message(hidden)).toBe('Unknown party');
    expect(reassigned.assignedTo).toEqual({ memberId: members.sales2, name: 'Anita Sales' });
    expect(wrongStore.statusCode).toBe(400);
    expect((await api(sales).patch(`/projects/${project.id}`, {})).statusCode).toBe(400);
  });
});

describe('finding projects', () => {
  it('filters by stage, party, assignee and text, within the member’s stores', async () => {
    const owners = await signup('Find Paints');
    const store = await idOf(api(owners).post('/stores', { name: 'Kukatpally', code: 'KPY' }));
    const other = await idOf(api(owners).post('/stores', { name: 'Vizag', code: 'VZG' }));
    const customer = await idOf(
      api(owners).post('/parties', { displayName: 'Reddy Homes', roles: ['customer'] }),
    );
    const painter = await idOf(
      api(owners).post('/parties', { displayName: 'Venu Painter', roles: ['painter'] }),
    );
    const base = { storeId: store, customerPartyId: customer };
    const villa = (
      await api(owners).post('/projects', {
        ...base,
        name: 'Lake View Villa',
        city: 'Hyderabad',
        expectedOrderValuePaise: 500,
        parties: [{ partyId: painter, role: 'painter' }],
      })
    ).json<Project>();
    const tower = (
      await api(owners).post('/projects', {
        ...base,
        name: 'Tower A',
        city: 'Secunderabad',
        expectedOrderValuePaise: 1_500,
      })
    ).json<Project>();
    await api(owners).post('/projects', { ...base, storeId: other, name: 'Beach House' });
    await api(owners).post(`/projects/${tower.id}/stage`, { stage: 'quotation' });

    const query = async (q: string) =>
      (await api(owners).get(`/projects?${q}`)).json<{ items: Project[]; total: number }>();
    const byPainter = await query(`partyId=${painter}`);
    const byCustomer = await query(`partyId=${customer}&storeId=${store}`);
    const byStage = await query('stage=quotation');
    const byCity = await query('q=secunderabad');
    const byCustomerName = await query('q=reddy&limit=1');
    const byNumber = await query(`q=${villa.number}`);
    const mine = await query('assignedTo=me');
    const board = (await api(owners).get(`/projects/pipeline?storeId=${store}&assignedTo=me`)).json<
      { stage: string; count: number; valuePaise: number }[]
    >();

    expect(byPainter.items.map((p) => p.id)).toEqual([villa.id]);
    expect(byCustomer.total).toBe(2);
    expect(byStage.items.map((p) => p.id)).toEqual([tower.id]);
    expect(byCity.items.map((p) => p.id)).toEqual([tower.id]);
    expect(byCustomerName).toMatchObject({ total: 3 });
    expect(byCustomerName.items).toHaveLength(1);
    expect(byNumber.items.map((p) => p.id)).toEqual([villa.id]);
    expect(mine.total).toBe(3);
    expect(byPainter.items[0]).toMatchObject({
      city: 'Hyderabad',
      expectedOrderValuePaise: 500,
      stage: 'identified',
    });
    expect(board.find((s) => s.stage === 'identified')).toEqual({
      stage: 'identified',
      count: 1,
      valuePaise: 500,
    });
    expect(board.find((s) => s.stage === 'quotation')).toEqual({
      stage: 'quotation',
      count: 1,
      valuePaise: 1_500,
    });
    expect(board.find((s) => s.stage === 'completed')).toEqual({
      stage: 'completed',
      count: 0,
      valuePaise: 0,
    });
  });

  it('keeps each store’s projects to the people who work there', async () => {
    const punProject = (
      await newProject({ storeId: pune, customerPartyId: party.puneCustomer }, punSales)
    ).json<Project>();

    expect((await api(sales).get(`/projects/${punProject.id}`)).statusCode).toBe(404);
    expect(
      (await api(sales).post(`/projects/${punProject.id}/stage`, { stage: 'survey' })).statusCode,
    ).toBe(404);
    expect((await api(sales).get(`/projects?storeId=${pune}`)).statusCode).toBe(404);
    expect(
      (await api(sales).get('/projects?limit=200'))
        .json<{ items: Project[] }>()
        .items.map((p) => p.id),
    ).not.toContain(punProject.id);
  });
});
