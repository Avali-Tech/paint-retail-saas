import { migrateDatabase, schema } from '@paint/db';
import { gstinCheckCharacter, toCsv, type GoLivePreview, type GoLiveResult } from '@paint/shared';
import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  api,
  billingBusiness,
  dbToday,
  ok,
  type BillingBusiness,
} from '../test-support/billing-business.js';
import { startTestApp, uniquePhone, type TestApp } from '../test-support/test-app.js';

const { creditProfiles, goLiveOpenings, parties, rolePermissions, roles } = schema;

interface Report {
  committed: boolean;
  valid: boolean;
  totals: { rows: number; create: number; update: number; unchanged: number; errors: number };
  rows: { row: number; action: string; label: string }[];
  errors: { row: number; column: string | null; message: string }[];
}

const COLUMNS = ['phone', 'gstin', 'name', 'opening_balance', 'overdue_since'];
const csv = (...rows: string[][]) => toCsv([COLUMNS, ...rows]);
const gstin = (pan: string) => {
  const first14 = `36${pan}1Z`;
  return `${first14}${gstinCheckCharacter(first14)}`;
};

let database: TestDatabase;
let t: TestApp;
let b: BillingBusiness;
let today: string;
const people = {
  sharma: { id: '', phone: uniquePhone(), gstin: gstin('AABCS1111A') },
  ravi: { id: '', phone: uniquePhone(), gstin: gstin('AABPR2222B') },
  farhan: { id: '', phone: uniquePhone() },
  kukatpally: { id: '', phone: uniquePhone(), gstin: gstin('AABCK3333C') },
  gone: { id: '', phone: uniquePhone() },
  registered: { id: '', gstin: gstin('AABCG4444D') },
};

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  t = await startTestApp(database.connectionString);
  b = await billingBusiness(t);
  today = await dbToday(t);
  const party = async (body: object) =>
    ok(await api(t, b.owner).post('/parties', { roles: ['customer'], ...body })).json<{
      id: string;
    }>().id;
  people.sharma.id = await party({
    displayName: 'Sharma Constructions',
    phone: people.sharma.phone,
    gstin: people.sharma.gstin,
  });
  people.ravi.id = await party({
    displayName: 'Ravi Painter',
    phone: people.ravi.phone,
    gstin: people.ravi.gstin,
  });
  people.farhan.id = await party({ displayName: 'Farhan Ali', phone: people.farhan.phone });
  people.kukatpally.id = await party({
    displayName: 'Kukatpally Paint House',
    phone: people.kukatpally.phone,
    gstin: people.kukatpally.gstin,
    homeStoreId: b.stores.kkp,
  });
  people.gone.id = await party({ displayName: 'Closed Account', phone: people.gone.phone });
  people.registered.id = await party({
    displayName: 'GSTIN Traders',
    gstin: people.registered.gstin,
  });
  await t.connection.db
    .update(parties)
    .set({ isActive: false })
    .where(eq(parties.id, people.gone.id));
  // MVP 1 figures for Farhan: ₹2,000 owed by hand, 4 days late, and none imported.
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: people.farhan.id,
    manualExposurePaise: 200_000,
    overdueDays: 4,
  });
  // …and for Ravi, whose imported balance replaces them but keeps the overdue days.
  await t.connection.db.insert(creditProfiles).values({
    organizationId: b.organizationId,
    partyId: people.ravi.id,
    manualExposurePaise: 999_900,
    overdueDays: 6,
  });
}, 180_000);

afterAll(async () => {
  await t.close();
  await database.stop();
});

const preview = async (body: string, token = b.owner) =>
  ok(await api(t, token).post('/imports/opening-balances/preview', { csv: body })).json<Report>();
const commit = (body: string, token = b.owner) =>
  api(t, token).post('/imports/opening-balances', { csv: body });

describe('opening-balances import', () => {
  it('offers a template and needs the go-live permission', async () => {
    const template = await api(t, b.owner).get('/imports/opening-balances/template');
    expect(template.body.split('\r\n')[0]).toBe(
      `${String.fromCharCode(0xfeff)}${COLUMNS.join(',')}`,
    );
    const sales = await b.member('sales_executive', [b.stores.amp]);
    expect(
      (await api(t, sales).post('/imports/opening-balances/preview', { csv: 'x' })).statusCode,
    ).toBe(403);
  });

  it('checks every row against the parties and today', async () => {
    const manager = await b.member('branch_manager', [b.stores.amp]);
    // A branch manager allowed to go live, who cannot see Kukatpally's parties.
    const [role] = await t.connection.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.organizationId, b.organizationId), eq(roles.key, 'branch_manager')));
    await t.connection.db.insert(rolePermissions).values({
      organizationId: b.organizationId,
      roleId: String(role?.id),
      permission: 'organization:manage',
    });
    const report = await preview(
      csv(
        ['', '', 'Nobody', '100', ''],
        ['9000099999', '', '', '100', ''],
        ['', gstin('AABCS9999Z'), '', '100', ''],
        [people.kukatpally.phone, people.ravi.gstin, '', '100', ''],
        ['', people.kukatpally.gstin, '', '100', ''],
        [people.gone.phone, '', '', '100', ''],
        [people.farhan.phone, '', 'Someone Else', '100', ''],
        [people.farhan.phone, '', '', '0', '2026-01-01'],
        [people.sharma.phone, '', '', '250', '31-02-2026'],
        [people.sharma.phone, '', '', '-5', ''],
        [people.ravi.phone, '', '', '250', '2099-01-01'],
        [people.sharma.phone, '', '', '250', ''],
        ['', people.sharma.gstin, '', '250', ''],
        ['', people.sharma.gstin, '', '250', ''],
        [people.sharma.phone, '', '', '250', ''],
      ),
      manager,
    );
    expect(report.valid).toBe(false);
    expect(report.rows).toEqual([
      { row: 13, action: 'create', label: 'Sharma Constructions · ₹250.00' },
    ]);
    expect(report.errors).toEqual([
      {
        row: 2,
        column: 'phone',
        message: 'Enter the mobile number or GSTIN the party is saved with',
      },
      {
        row: 3,
        column: 'phone',
        message: 'No party has this mobile number or GSTIN; import parties first',
      },
      {
        row: 4,
        column: 'gstin',
        message: 'No party has this mobile number or GSTIN; import parties first',
      },
      {
        row: 5,
        column: 'phone',
        message: "This number is Kukatpally Paint House's, but the GSTIN is Ravi Painter's",
      },
      { row: 6, column: 'phone', message: 'Matches a party at a store you cannot access' },
      {
        row: 7,
        column: 'phone',
        message: 'Closed Account is inactive or merged into another party',
      },
      { row: 8, column: 'name', message: 'This is Farhan Ali, not Someone Else' },
      { row: 9, column: 'overdue_since', message: 'Only for a party that owes something' },
      {
        row: 10,
        column: 'overdue_since',
        message: 'Enter a date such as 2026-04-01 or 01-04-2026',
      },
      { row: 11, column: 'opening_balance', message: 'Cannot be negative' },
      { row: 12, column: 'overdue_since', message: 'Cannot be in the future' },
      { row: 14, column: 'phone', message: 'Sharma Constructions is also on row 13' },
      { row: 15, column: 'gstin', message: 'Also on row 14' },
      { row: 16, column: 'phone', message: 'Also on row 13' },
    ]);
  });

  it('saves the balances for the go-live, and imports them again idempotently', async () => {
    const file = csv(
      ['', people.sharma.gstin, 'sharma constructions', '45,000.50', '15-03-2026'],
      [people.ravi.phone, '', 'Ravi Painter', '1200', ''],
      ['', people.registered.gstin, '', '0', ''],
    );
    const first = await preview(file);
    expect(first).toMatchObject({
      committed: false,
      valid: true,
      totals: { rows: 3, create: 3, update: 0, unchanged: 0, errors: 0 },
      rows: [
        { row: 2, action: 'create', label: 'Sharma Constructions · ₹45,000.50' },
        { row: 3, action: 'create', label: 'Ravi Painter · ₹1,200.00' },
        { row: 4, action: 'create', label: 'GSTIN Traders · ₹0.00' },
      ],
    });
    expect(ok(await commit(file)).json<Report>()).toMatchObject({
      committed: true,
      totals: { create: 3 },
    });
    expect(ok(await commit(file)).json<Report>().totals).toMatchObject({
      create: 0,
      update: 0,
      unchanged: 3,
    });

    const changed = csv(
      ['', people.sharma.gstin, '', '45000.50', '2026-03-16'],
      [people.ravi.phone, '', '', '1300', ''],
    );
    expect((await preview(changed)).totals).toMatchObject({ update: 2, unchanged: 0 });
    ok(await commit(changed));
    const saved = await t.connection.db
      .select({
        partyId: goLiveOpenings.partyId,
        amountPaise: goLiveOpenings.amountPaise,
        overdueSince: goLiveOpenings.overdueSince,
      })
      .from(goLiveOpenings)
      .where(eq(goLiveOpenings.organizationId, b.organizationId));
    expect(saved).toEqual(
      expect.arrayContaining([
        { partyId: people.sharma.id, amountPaise: 4_500_050, overdueSince: '2026-03-16' },
        { partyId: people.ravi.id, amountPaise: 130_000, overdueSince: null },
      ]),
    );
  });

  it('feeds the go-live: imported balances first, the hand-entered exposure for the rest', async () => {
    const overdue = await dbToday(t, -4);
    const ravisOverdue = await dbToday(t, -6);
    const preview = ok(await api(t, b.owner).get('/sales/go-live')).json<GoLivePreview>();
    expect(preview.openings).toEqual([
      {
        partyId: people.farhan.id,
        partyName: 'Farhan Ali',
        manualExposurePaise: 200_000,
        overdueDays: 4,
        amountPaise: 200_000,
        overdueSince: overdue,
        source: 'manual',
      },
      {
        partyId: people.registered.id,
        partyName: 'GSTIN Traders',
        manualExposurePaise: 0,
        overdueDays: 0,
        amountPaise: 0,
        overdueSince: null,
        source: 'import',
      },
      {
        partyId: people.ravi.id,
        partyName: 'Ravi Painter',
        manualExposurePaise: 999_900,
        overdueDays: 6,
        amountPaise: 130_000,
        overdueSince: ravisOverdue,
        source: 'import',
      },
      {
        partyId: people.sharma.id,
        partyName: 'Sharma Constructions',
        manualExposurePaise: 0,
        overdueDays: 0,
        amountPaise: 4_500_050,
        overdueSince: '2026-03-16',
        source: 'import',
      },
    ]);

    // Overridden by hand for one party at the go-live itself.
    const result = ok(
      await api(t, b.owner).post('/sales/go-live', {
        openings: [
          { partyId: people.ravi.id, amountPaise: 140_000 },
          // Null: nothing of Farhan's is overdue, whatever was entered by hand.
          { partyId: people.farhan.id, amountPaise: 200_000, overdueSince: null },
        ],
      }),
    ).json<GoLiveResult>();
    expect(result).toEqual({
      billingLiveOn: today,
      openingEntries: 3,
      openingTotalPaise: 200_000 + 140_000 + 4_500_050,
    });
    const [sharma] = await t.connection.db
      .select({ since: creditProfiles.openingOverdueSince })
      .from(creditProfiles)
      .where(eq(creditProfiles.partyId, people.sharma.id));
    expect(sharma?.since).toBe('2026-03-16');
    const since = async (partyId: string) =>
      (
        await t.connection.db
          .select({ since: creditProfiles.openingOverdueSince })
          .from(creditProfiles)
          .where(eq(creditProfiles.partyId, partyId))
      )[0]?.since;
    // Left out, Ravi keeps the overdue days entered by hand.
    expect(await since(people.ravi.id)).toBe(ravisOverdue);
    expect(await since(people.farhan.id)).toBeNull();
  });

  it('is refused once billing is live, by the import and by the database', async () => {
    const file = csv([people.ravi.phone, '', '', '1', '']);
    const refused = await preview(file);
    expect(refused.errors).toEqual([
      {
        row: 1,
        column: null,
        message: `Billing went live on ${today}: opening balances are in the party ledger now`,
      },
    ]);
    expect(refused.rows).toEqual([]);
    expect((await commit(file)).statusCode).toBe(400);
    await expect(
      t.connection.db
        .update(goLiveOpenings)
        .set({ amountPaise: 1 })
        .where(eq(goLiveOpenings.partyId, people.ravi.id)),
    ).rejects.toThrow();
  });
});
