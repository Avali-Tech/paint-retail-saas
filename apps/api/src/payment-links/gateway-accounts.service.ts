import 'reflect-metadata';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import type { GatewayAccountView, GatewayTestResult } from '@paint/shared';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { GatewayError } from '../payments-gateway/payment-gateway.js';
import { PAYMENT_LINK_GATEWAYS, PaymentLinkGateways } from './payment-link-gateways.js';
import type { ConnectGatewayInput } from './payment-links.schemas.js';
import type { RazorpayPaymentLinkProvider } from './razorpay-payment-links.js';

const { organizationMembers, paymentGatewayAccounts, users } = schema;

const last4 = (value: string) => value.slice(-4);

/**
 * Each business's own Razorpay account ([PO-40], spec §6.2 PL-14): owners and admins
 * connect it with the keys from Razorpay's dashboard, test it, and disconnect it. The
 * keys are checked with a harmless call before they are kept, then sealed (envelope
 * encryption, `credential-vault.ts`); no answer, log line, audit row or error ever
 * carries a secret, only the last four characters of each.
 */
@Injectable()
export class GatewayAccountsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PAYMENT_LINK_GATEWAYS) private readonly gateways: PaymentLinkGateways,
  ) {}

  private razorpayOnly(): void {
    if (this.gateways.provider !== 'razorpay') {
      throw new ConflictException({
        statusCode: 409,
        code: 'gateway_not_razorpay',
        message: 'Payment links do not use Razorpay here',
      });
    }
  }

  /** The business's account as the settings screen shows it; null without Razorpay. */
  view(auth: AuthContext): Promise<GatewayAccountView | null> {
    if (this.gateways.provider !== 'razorpay') return Promise.resolve(null);
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.viewIn(tx, auth.organization.id),
    );
  }

  private async viewIn(tx: Transaction, organizationId: string): Promise<GatewayAccountView> {
    const [row] = await tx
      .select({
        webhookRef: paymentGatewayAccounts.webhookRef,
        live: paymentGatewayAccounts.live,
        keyIdHint: paymentGatewayAccounts.keyIdHint,
        keySecretHint: paymentGatewayAccounts.keySecretHint,
        webhookSecretHint: paymentGatewayAccounts.webhookSecretHint,
        connectedAt: paymentGatewayAccounts.connectedAt,
        connectedBy: users.fullName,
        verifiedAt: paymentGatewayAccounts.verifiedAt,
      })
      .from(paymentGatewayAccounts)
      .leftJoin(
        organizationMembers,
        eq(organizationMembers.id, paymentGatewayAccounts.connectedByMemberId),
      )
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(paymentGatewayAccounts.organizationId, organizationId));
    // Every business has a webhook address to paste, even before it connects.
    const webhookRef = row?.webhookRef ?? (await this.ensureAccount(tx, organizationId));
    return {
      gateway: 'razorpay',
      connected: Boolean(row?.connectedAt),
      live: row?.live ?? null,
      keyIdHint: row?.keyIdHint ?? null,
      keySecretHint: row?.keySecretHint ?? null,
      webhookSecretHint: row?.webhookSecretHint ?? null,
      connectedAt: row?.connectedAt?.toISOString() ?? null,
      connectedBy: row?.connectedBy ?? null,
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      webhookUrl: this.gateways.webhookUrl(webhookRef),
    };
  }

  /** The business's (unconnected) account row with a fresh webhook reference. */
  private async ensureAccount(tx: Transaction, organizationId: string): Promise<string> {
    await tx
      .insert(paymentGatewayAccounts)
      .values({
        organizationId,
        gateway: 'razorpay',
        webhookRef: randomBytes(16).toString('base64url'),
      })
      .onConflictDoNothing({ target: paymentGatewayAccounts.organizationId });
    const [row] = (await tx
      .select({ webhookRef: paymentGatewayAccounts.webhookRef })
      .from(paymentGatewayAccounts)
      .where(eq(paymentGatewayAccounts.organizationId, organizationId))) as [
      { webhookRef: string },
    ];
    return row.webhookRef;
  }

  /** Checks the keys with a harmless call; 409 naming only Razorpay's error code. */
  private async check(provider: RazorpayPaymentLinkProvider): Promise<void> {
    try {
      await provider.testConnection();
    } catch (error) {
      const code = error instanceof GatewayError ? error.code : 'error';
      throw new ConflictException({
        statusCode: 409,
        code: 'gateway_rejected',
        message:
          code === 'unauthorized'
            ? 'Razorpay did not accept these keys: check the key id and key secret'
            : `Razorpay could not be checked just now (${code}): try again`,
      });
    }
  }

  /** Connects (or replaces) the business's keys, once Razorpay accepts them. */
  async connect(auth: AuthContext, input: ConnectGatewayInput): Promise<GatewayAccountView> {
    this.razorpayOnly();
    await this.check(this.gateways.razorpay(input));
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      await this.ensureAccount(tx, organizationId);
      await tx
        .update(paymentGatewayAccounts)
        .set({
          keyIdHint: last4(input.keyId),
          keySecretHint: last4(input.keySecret),
          webhookSecretHint: last4(input.webhookSecret),
          live: input.keyId.startsWith('rzp_live_'),
          credentialsSealed: this.gateways.vault.seal(organizationId, {
            keyId: input.keyId,
            keySecret: input.keySecret,
            webhookSecret: input.webhookSecret,
          }),
          connectedAt: sql`now()`,
          connectedByMemberId: auth.memberId,
          verifiedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentGatewayAccounts.organizationId, organizationId));
      return this.viewIn(tx, organizationId);
    });
  }

  /** The settings screen's test button: the kept keys answer a harmless call. */
  async test(auth: AuthContext): Promise<GatewayTestResult> {
    this.razorpayOnly();
    const organizationId = auth.organization.id;
    const provider = await withTenant(this.connection.db, organizationId, (tx) =>
      this.gateways.forBusiness(tx, organizationId),
    );
    if (provider === null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'gateway_not_connected',
        message: 'Connect your Razorpay account first',
      });
    }
    await this.check(provider as RazorpayPaymentLinkProvider);
    return withTenant(this.connection.db, organizationId, async (tx) => {
      const [row] = (await tx
        .update(paymentGatewayAccounts)
        .set({ verifiedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(paymentGatewayAccounts.organizationId, organizationId))
        .returning({ verifiedAt: paymentGatewayAccounts.verifiedAt })) as [{ verifiedAt: Date }];
      return { ok: true, verifiedAt: row.verifiedAt.toISOString() };
    });
  }

  /**
   * Forgets the keys: no new links until it connects again. The webhook address stays,
   * so reconnecting needs no change at Razorpay; webhooks meanwhile are refused (404) and
   * Razorpay retries them.
   */
  async disconnect(auth: AuthContext): Promise<GatewayAccountView> {
    this.razorpayOnly();
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      await tx
        .update(paymentGatewayAccounts)
        .set({
          keyIdHint: null,
          keySecretHint: null,
          webhookSecretHint: null,
          live: null,
          credentialsSealed: null,
          connectedAt: null,
          connectedByMemberId: null,
          verifiedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(paymentGatewayAccounts.organizationId, organizationId));
      return this.viewIn(tx, organizationId);
    });
  }
}
