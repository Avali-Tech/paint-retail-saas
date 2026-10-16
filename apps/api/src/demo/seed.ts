import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  LatestReconciliation,
  PlanChangeResult,
  SubscriptionInvoiceView,
  SubscriptionView,
  TenantBillingView,
} from '@paint/shared';
import type { DatabaseConnection } from '@paint/db';
import pg from 'pg';
import { base32Decode, sealSecret, totp } from '../auth/totp.js';
import { DATABASE } from '../database/database.module.js';
import { sendDueMessages } from '../messaging/outbox.js';
import {
  NotificationsWorker,
  WORKER_SETTINGS,
  type WorkerSettings,
} from '../notifications/notifications-worker.js';
import { DemoApi, type MemberApi } from './api-client.js';
import { HistoryClock, indiaDate } from './history-clock.js';
import type { LargeScale } from './large-plan.js';
import {
  buildPlan,
  DEMO_BUSINESS,
  DEMO_OPERATOR,
  DEMO_OPERATOR_TOTP_SECRET,
  DEMO_PAID_PLAN,
  DEMO_PASSWORD,
  DEMO_SEED,
  DEMO_SLUG,
  DEMO_TOTP_SECRET,
  DEMO_TRIAL_BUSINESS,
  type DemoSize,
  type TeamMemberPlan,
} from './plan.js';
import { Random } from './random.js';
import { scheduleCredit, scheduleDuplicates, scheduleLoyalty } from './seed-accounts.js';
import { followUpEscalations, scheduleCollections, shareStatements } from './seed-collections.js';
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
import { assertReconciled } from './seed-billing.js';
import { onboardBusinesses, seedLargeShop } from './seed-large.js';
import { schedulePainterPoints } from './seed-points.js';
import { seedSchemes } from './seed-schemes.js';
import { scheduleSales } from './seed-sales.js';
import { setUpBusiness, setUpCatalogueAndParties, type ReadSmsCode } from './seed-setup.js';
import { scheduleSites } from './seed-sites.js';

export interface SeedOptions {
  /** The API, created in-process with an SMS sender the seed can read. */
  readonly app: NestFastifyApplication;
  readonly databaseUrl: string;
  /** The API's AUTH_SECRET: the demo admin's authenticator secret is sealed with it. */
  readonly authSecret: string;
  /** The in-process API's PLATFORM_BOOTSTRAP_TOKEN, to create the demo's platform operator. */
  readonly platformBootstrapToken: string;
  readonly size: DemoSize;
  /** The large shop added on top of the full demo (size `large`); null otherwise. */
  readonly large: LargeScale | null;
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
  /** Its branded sign-in page is /sign-in?b=<slug>. */
  readonly slug: string;
  readonly password: string;
  readonly people: readonly DemoPerson[];
  readonly twoFactor: {
    readonly name: string;
    readonly phone: string;
    readonly secret: string;
    readonly otpauthUri: string;
    readonly recoveryCodes: readonly string[];
  };
  /** A second business on its free trial; its owner signs in with a mobile code. */
  readonly trialBusiness: { readonly name: string; readonly owner: string; readonly phone: string };
  /** The plan the demo business pays for. */
  readonly plan: string;
  /** The platform operator for the console at /platform. */
  readonly operator: {
    readonly name: string;
    readonly email: string;
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
  const demo = buildPlan(options.size === 'small' ? 'small' : 'full');
  const clock = new HistoryClock(options.databaseUrl);
  const context = new SeedContext(demo, new Random(DEMO_SEED + 1), new DemoApi(options.app), clock);
  const worker = options.app.get<symbol, WorkerSettings>(WORKER_SETTINGS);
  const { db } = options.app.get<symbol, DatabaseConnection>(DATABASE);
  context.sendMessages = () => sendDueMessages(db, { ...worker.messaging, email: worker.sender });
  try {
    await clock.day(demo.historyDays + 2, () => setUpBusiness(context, options.readSmsCode));
    await clock.day(demo.historyDays + 1, () => setUpCatalogueAndParties(context));

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
    scheduleSales(context, timeline);
    scheduleSites(context, timeline);
    scheduleCollections(context, timeline);
    schedulePainterPoints(context, timeline);
    // The owner caught up with notifications a few days ago; newer ones stay unread.
    timeline.at(3, async () => {
      await context.as('owner').post('/notifications/read-all');
    });
    // Each day's messages to parties go out that day (the running API's worker sends them).
    for (let daysAgo = demo.historyDays - 1; daysAgo >= 1; daysAgo--) {
      timeline.at(daysAgo, async () => {
        await context.sendMessages();
      });
    }
    await timeline.play(clock);
    await clock.apply();
  } finally {
    await clock.close();
  }

  // Brand schemes over the purchases just made (P2-M33), entered today.
  await seedSchemes(context);

  // The business signed up on the free trial; today the owner asks for a plan, the
  // platform's operator applies it and records the bank transfer for our invoice.
  const { operator, token: operatorToken } = await createOperator(options);
  const plan = await subscribe(context, new DemoApi(options.app).as(operatorToken));

  if (options.large !== null) {
    await seedLargeShop(context, options.databaseUrl, options.large, new Date());
  }

  // Today's reminders and alerts (stock at its reorder level, follow-ups due,
  // renewals), the nightly reconciliation of the books, which must find nothing, the
  // overdue holds and the collections run (promises settled, payment reminders),
  // run at noon India time so messaging hours (spec MSG-6) never depend on the hour.
  await shareStatements(context);
  await options.app.get(NotificationsWorker).runOnce(new Date(`${indiaDate(0)}T12:00:00+05:30`));
  await followUpEscalations(context);
  assertReconciled(await context.as('owner').get<LatestReconciliation>('/reconciliation/latest'));
  const twoFactor = await enrolAuthenticator(context, options);
  await new DemoApi(options.app).as(operatorToken).post('/platform/tenants', {
    ...DEMO_TRIAL_BUSINESS,
    plan: 'trial',
  });
  if (options.large !== null) {
    await onboardBusinesses(context, operatorToken, options.large.otherBusinesses);
  }

  const owner = context.as('owner');
  const low = await owner.get<{ total: number }>('/stock/low?limit=1');
  const notifications = await owner.get<{ unread: number }>('/notifications?limit=1');
  context.count('low stock items', low.total);
  context.count('unread notifications for the owner', notifications.unread);

  const storeNames = new Map(demo.stores.map((store) => [store.key, store.name]));
  const people = [demo.owner, ...demo.team].map((person): DemoPerson => ({
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
    credentials: {
      business: DEMO_BUSINESS,
      slug: DEMO_SLUG,
      password: DEMO_PASSWORD,
      people,
      twoFactor,
      trialBusiness: {
        name: DEMO_TRIAL_BUSINESS.organizationName,
        owner: DEMO_TRIAL_BUSINESS.owner.fullName,
        phone: DEMO_TRIAL_BUSINESS.owner.phone,
      },
      plan,
      operator,
    },
    counts: Object.fromEntries(context.created),
  };
}

/**
 * The owner moves the business from its free trial to a paid plan the way any owner
 * does with manual invoicing (Settings → Billing): asks for the plan; the platform's
 * operator applies it, which raises our first GST invoice, and records the bank
 * transfer that pays it, which starts the plan.
 */
async function subscribe(context: SeedContext, platform: MemberApi): Promise<string> {
  const owner = context.as('owner');
  const { request } = await owner.post<Extract<PlanChangeResult, { kind: 'requested' }>>(
    '/subscription/change',
    DEMO_PAID_PLAN,
  );
  const tenantId = (await owner.get<{ organization: { id: string } }>('/auth/me')).organization.id;
  const billing = await platform.post<TenantBillingView>(
    `/platform/tenants/${tenantId}/plan-requests/${request.id}/apply`,
  );
  const [invoice] = billing.invoices as [SubscriptionInvoiceView];
  await platform.post(`/platform/tenants/${tenantId}/invoices/${invoice.id}/payments`, {
    amountPaise: invoice.totalPaise,
    paidOn: invoice.issuedOn,
    mode: 'bank_transfer',
    reference: 'UTR HDFCR52026000001',
  });
  const subscription = await owner.get<SubscriptionView>('/subscription');
  context.count('subscription invoices', 1);
  return `${subscription.planName}, ${String(subscription.interval)}`;
}

/**
 * The admin who shows two-factor sign-in adds an authenticator through the
 * API; the seed then swaps the random secret for the fixed demo one (sealed
 * the way the API seals it) before confirming, so a phone set up once keeps
 * working after every reset.
 */
/** Replaces a user's authenticator secret with a fixed one, sealed the way the API seals it. */
async function fixSecret(
  options: SeedOptions,
  secret: Buffer,
  userIdQuery: string,
  param: string,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 1 });
  try {
    await pool.query(
      `UPDATE user_totp SET secret_ciphertext = $1 WHERE user_id = (${userIdQuery})`,
      [sealSecret(options.authSecret, secret), param],
    );
  } finally {
    await pool.end();
  }
}

/**
 * The demo's platform operator, created the way the first real operator is
 * (POST /platform/bootstrap), then signed in once to add an authenticator app
 * whose random secret is swapped for the fixed demo one before confirming.
 */
async function createOperator(
  options: SeedOptions,
): Promise<{ operator: DemoCredentials['operator']; token: string }> {
  const api = new DemoApi(options.app).public;
  await api.post('/platform/bootstrap', {
    token: options.platformBootstrapToken,
    ...DEMO_OPERATOR,
    password: DEMO_PASSWORD,
  });
  const { twoFactor } = await api.post<{ twoFactor: { pendingToken: string } }>('/platform/login', {
    identifier: DEMO_OPERATOR.email,
    password: DEMO_PASSWORD,
  });
  const enrolment = await api.post<{ otpauthUri: string }>('/platform/login/2fa/setup', {
    pendingToken: twoFactor.pendingToken,
  });
  const secret = base32Decode(DEMO_OPERATOR_TOTP_SECRET);
  await fixSecret(options, secret, 'SELECT id FROM users WHERE email = $2', DEMO_OPERATOR.email);
  const { recoveryCodes, token } = await api.post<{ recoveryCodes: string[]; token: string }>(
    '/platform/login/2fa',
    {
      pendingToken: twoFactor.pendingToken,
      code: totp(secret, Date.now()),
    },
  );
  return {
    operator: {
      name: DEMO_OPERATOR.fullName,
      email: DEMO_OPERATOR.email,
      secret: DEMO_OPERATOR_TOTP_SECRET,
      otpauthUri: enrolment.otpauthUri.replace(
        /secret=[A-Z2-7]+/,
        `secret=${DEMO_OPERATOR_TOTP_SECRET}`,
      ),
      recoveryCodes,
    },
    token,
  };
}

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
  await fixSecret(
    options,
    secret,
    'SELECT user_id FROM organization_members WHERE id = $2',
    context.memberId(person.key),
  );
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
