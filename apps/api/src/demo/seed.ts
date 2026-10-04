import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { base32Decode, sealSecret, totp } from '../auth/totp.js';
import { NotificationsWorker } from '../notifications/notifications-worker.js';
import { DemoApi } from './api-client.js';
import { HistoryClock } from './history-clock.js';
import {
  buildPlan,
  DEMO_BUSINESS,
  DEMO_PASSWORD,
  DEMO_SEED,
  DEMO_TOTP_SECRET,
  type DemoSize,
  type TeamMemberPlan,
} from './plan.js';
import { Random } from './random.js';
import { scheduleCredit, scheduleDuplicates, scheduleLoyalty } from './seed-accounts.js';
import { must, SeedContext, Timeline } from './seed-context.js';
import {
  scheduleContracts,
  scheduleFollowUps,
  scheduleLeads,
  scheduleProjects,
} from './seed-crm.js';
import {
  scheduleAdjustments,
  scheduleOpeningStock,
  schedulePurchasing,
  scheduleStockCounts,
  scheduleTransfers,
} from './seed-inventory.js';
import { setUpBusiness, setUpCatalogueAndParties, type ReadSmsCode } from './seed-setup.js';

export interface SeedOptions {
  /** The API, created in-process with an SMS sender the seed can read. */
  readonly app: NestFastifyApplication;
  readonly databaseUrl: string;
  /** The API's AUTH_SECRET: the demo admin's authenticator secret is sealed with it. */
  readonly authSecret: string;
  readonly size: DemoSize;
  readonly readSmsCode: ReadSmsCode;
}

export interface DemoPerson {
  readonly name: string;
  readonly role: string;
  readonly stores: string;
  readonly phone: string;
  readonly email: string | null;
  readonly signIn: 'password' | 'mobile code' | 'password + authenticator app';
}

export interface DemoCredentials {
  readonly business: string;
  readonly password: string;
  readonly people: readonly DemoPerson[];
  readonly twoFactor: {
    readonly name: string;
    readonly phone: string;
    readonly secret: string;
    readonly otpauthUri: string;
    readonly recoveryCodes: readonly string[];
  };
}

export interface SeedResult {
  readonly credentials: DemoCredentials;
  /** What was created, for the summary. */
  readonly counts: Readonly<Record<string, number>>;
}

const ROLE_NAMES: Record<TeamMemberPlan['roleKey'], string> = {
  owner: 'Owner',
  org_admin: 'Organization Admin',
  branch_manager: 'Branch Manager',
  inventory_manager: 'Inventory Manager',
  sales_executive: 'Sales Executive',
  crm_executive: 'CRM Executive',
  store_employee: 'Store Employee',
};

/**
 * Creates the demo business through the real API: about two months of a
 * three-branch paint dealer in Hyderabad, ending today.
 */
export async function seedDemo(options: SeedOptions): Promise<SeedResult> {
  const plan = buildPlan(options.size);
  const clock = new HistoryClock(options.databaseUrl);
  const context = new SeedContext(plan, new Random(DEMO_SEED + 1), new DemoApi(options.app), clock);
  try {
    await clock.day(plan.historyDays + 2, () => setUpBusiness(context, options.readSmsCode));
    await clock.day(plan.historyDays + 1, () => setUpCatalogueAndParties(context));

    const timeline = new Timeline();
    scheduleOpeningStock(context, timeline);
    schedulePurchasing(context, timeline);
    scheduleTransfers(context, timeline);
    scheduleAdjustments(context, timeline);
    scheduleStockCounts(context, timeline);
    scheduleProjects(context, timeline);
    scheduleLeads(context, timeline);
    scheduleContracts(context, timeline);
    scheduleFollowUps(context, timeline);
    scheduleCredit(context, timeline);
    scheduleLoyalty(context, timeline);
    scheduleDuplicates(context, timeline);
    // The owner caught up with notifications a few days ago; newer ones stay unread.
    timeline.at(3, async () => {
      await context.as('owner').post('/notifications/read-all');
    });
    await timeline.play(clock);
    await clock.apply();
  } finally {
    await clock.close();
  }

  // Today's reminders and alerts: stock at its reorder level, follow-ups due, renewals.
  await options.app.get(NotificationsWorker).runOnce();
  const twoFactor = await enrolAuthenticator(context, options);

  const owner = context.as('owner');
  const low = await owner.get<{ total: number }>('/stock/low?limit=1');
  const notifications = await owner.get<{ unread: number }>('/notifications?limit=1');
  context.count('low stock items', low.total);
  context.count('unread notifications for the owner', notifications.unread);

  const storeNames = new Map(plan.stores.map((store) => [store.key, store.name]));
  const people = [plan.owner, ...plan.team].map((person): DemoPerson => ({
    name: person.fullName,
    role: ROLE_NAMES[person.roleKey],
    stores: person.allStores
      ? 'All stores'
      : person.stores.map((store) => storeNames.get(store)).join(', '),
    phone: person.phone,
    email: person.email,
    signIn: person.twoFactor
      ? 'password + authenticator app'
      : person.hasPassword
        ? 'password'
        : 'mobile code',
  }));
  return {
    credentials: { business: DEMO_BUSINESS, password: DEMO_PASSWORD, people, twoFactor },
    counts: Object.fromEntries(context.created),
  };
}

/**
 * The admin who shows two-factor sign-in adds an authenticator through the
 * API; the seed then swaps the random secret for the fixed demo one (sealed
 * the way the API seals it) before confirming, so a phone set up once keeps
 * working after every reset.
 */
async function enrolAuthenticator(
  context: SeedContext,
  options: SeedOptions,
): Promise<DemoCredentials['twoFactor']> {
  const person = must(
    context.plan.team.find((member) => member.twoFactor),
    'two-factor admin',
  );
  const api = context.as(person.key);
  const enrolment = await api.post<{ otpauthUri: string }>('/auth/2fa/enrol');
  const secret = base32Decode(DEMO_TOTP_SECRET);
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 1 });
  try {
    await pool.query(
      `UPDATE user_totp SET secret_ciphertext = $1
        WHERE user_id = (SELECT user_id FROM organization_members WHERE id = $2)`,
      [sealSecret(options.authSecret, secret), context.memberId(person.key)],
    );
  } finally {
    await pool.end();
  }
  const { recoveryCodes } = await api.post<{ recoveryCodes: string[] }>('/auth/2fa/confirm', {
    code: totp(secret, Date.now()),
  });
  return {
    name: person.fullName,
    phone: person.phone,
    secret: DEMO_TOTP_SECRET,
    otpauthUri: enrolment.otpauthUri.replace(/secret=[A-Z2-7]+/, `secret=${DEMO_TOTP_SECRET}`),
    recoveryCodes,
  };
}
