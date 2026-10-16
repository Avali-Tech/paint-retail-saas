import { Logger } from '@nestjs/common';
import { schema, type Database, type Transaction } from '@paint/db';
import {
  DEFAULT_LINK_CAP_PAISE,
  DEFAULT_LINK_VALIDITY_MINUTES,
  type LinkAmountBasis,
} from '@paint/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type {
  PaymentLinkProviderName as ConfiguredProvider,
  PaymentLinksConfig,
} from '../config.js';
import { CredentialVault } from './credential-vault.js';
import { LogPaymentLinkProvider, type PaymentLinkProvider } from './payment-link-provider.js';
import {
  RazorpayPaymentLinkProvider,
  type RazorpayCredentials,
  type RazorpayOptions,
} from './razorpay-payment-links.js';

const { paymentGatewayAccounts, salesSettings } = schema;

/** Nest token of the PaymentLinkGateways every module that makes links shares. */
export const PAYMENT_LINK_GATEWAYS = Symbol('PAYMENT_LINK_GATEWAYS');

/** Where a gateway posts its webhooks: /webhooks/payment-links/<provider>[/<business>]. */
export const WEBHOOK_PATH = '/webhooks/payment-links';

/** A business's link rules ([PO-41] – [PO-43]), from its sales settings. */
export interface LinkRules {
  readonly validityMinutes: number;
  readonly capPaise: number;
  readonly amountBasis: LinkAmountBasis;
}

/** The business's link rules (tenant scope), or the defaults before it saved any. */
export async function linkRulesOf(tx: Transaction): Promise<LinkRules> {
  const [row] = await tx
    .select({
      validityMinutes: salesSettings.paymentLinkValidityMinutes,
      capPaise: salesSettings.paymentLinkCapPaise,
      amountBasis: salesSettings.paymentLinkAmountBasis,
    })
    .from(salesSettings);
  return (
    row ?? {
      validityMinutes: DEFAULT_LINK_VALIDITY_MINUTES,
      capPaise: DEFAULT_LINK_CAP_PAISE,
      amountBasis: 'net',
    }
  );
}

/**
 * The payment-link gateway of the platform (PAYMENT_LINK_PROVIDER) and of each business
 * (rule PL-1, [PO-40]): `log` serves every business with one pretend gateway; with
 * `razorpay` each business uses its own account, whose sealed credentials are opened
 * for each use and never kept. Null where links are off or the business has not
 * connected its account.
 */
export class PaymentLinkGateways {
  private readonly logger = new Logger('PaymentLinkGateways');
  /** The pretend gateway, when it is the platform's. */
  readonly log: LogPaymentLinkProvider | null;

  constructor(
    readonly name: ConfiguredProvider,
    private readonly options: {
      readonly appUrl: string;
      readonly publicApiUrl: string;
      /** Opens businesses' credentials; required with Razorpay. */
      readonly vault: CredentialVault | null;
      readonly razorpay: RazorpayOptions;
    },
  ) {
    this.log = name === 'log' ? new LogPaymentLinkProvider(options.appUrl) : null;
  }

  static fromConfig(
    config: PaymentLinksConfig,
    urls: { readonly appUrl: string; readonly publicApiUrl: string },
    fetch?: typeof globalThis.fetch,
  ): PaymentLinkGateways {
    const keys = config.credentialsKeys;
    return new PaymentLinkGateways(config.provider, {
      ...urls,
      vault: keys === null ? null : new CredentialVault(keys.current, keys.previous),
      razorpay: { apiUrl: config.razorpayApiUrl, ...(fetch === undefined ? {} : { fetch }) },
    });
  }

  /** The platform's provider, or null when links are off. */
  get provider(): 'log' | 'razorpay' | null {
    return this.name === 'disabled' ? null : this.name;
  }

  /** The vault that seals businesses' credentials (Razorpay only). */
  get vault(): CredentialVault {
    if (this.options.vault === null) throw new Error('No GATEWAY_CREDENTIALS_KEY');
    return this.options.vault;
  }

  /** A Razorpay adapter on a business's own keys. */
  razorpay(credentials: RazorpayCredentials): RazorpayPaymentLinkProvider {
    return new RazorpayPaymentLinkProvider(credentials, this.options.razorpay);
  }

  /** The business's sealed keys opened into an adapter, or null when they cannot be. */
  private opened(organizationId: string, sealed: string): RazorpayPaymentLinkProvider | null {
    try {
      const { keyId, keySecret, webhookSecret } = this.vault.open(organizationId, sealed);
      return this.razorpay({
        keyId: String(keyId),
        keySecret: String(keySecret),
        webhookSecret: String(webhookSecret),
      });
    } catch {
      // Never the error's text: it could only be about keys.
      this.logger.error(
        `The gateway credentials of business ${organizationId} could not be opened`,
      );
      return null;
    }
  }

  /** The gateway a business's links use now (tenant scope), or null. */
  async forBusiness(tx: Transaction, organizationId: string): Promise<PaymentLinkProvider | null> {
    if (this.name !== 'razorpay') return this.log;
    const [account] = await tx
      .select({ sealed: paymentGatewayAccounts.credentialsSealed })
      .from(paymentGatewayAccounts)
      .where(eq(paymentGatewayAccounts.organizationId, organizationId));
    if (!account?.sealed) return null;
    const provider = this.opened(organizationId, account.sealed);
    // Sealed under the previous key (a rotation): sealed again under the current one.
    if (provider !== null && !this.vault.isCurrent(account.sealed)) {
      await tx
        .update(paymentGatewayAccounts)
        .set({
          credentialsSealed: this.vault.seal(
            organizationId,
            this.vault.open(organizationId, account.sealed),
          ),
          updatedAt: sql`now()`,
        })
        .where(eq(paymentGatewayAccounts.organizationId, organizationId));
    }
    return provider;
  }

  /**
   * Who verifies a webhook posted to /webhooks/payment-links/<provider>[/<businessRef>]
   * (platform scope): the log gateway with no business, or the Razorpay account the
   * reference names, with its business. Null when no such route exists.
   */
  async forWebhook(
    db: Database,
    providerName: string,
    businessRef: string | undefined,
  ): Promise<{ provider: PaymentLinkProvider; organizationId: string | null } | null> {
    if (providerName !== this.name || this.name === 'disabled') return null;
    if (this.log !== null) {
      return businessRef === undefined ? { provider: this.log, organizationId: null } : null;
    }
    if (businessRef === undefined) return null;
    const [account] = await db
      .select({
        organizationId: paymentGatewayAccounts.organizationId,
        sealed: paymentGatewayAccounts.credentialsSealed,
      })
      .from(paymentGatewayAccounts)
      .where(
        and(
          eq(paymentGatewayAccounts.webhookRef, businessRef),
          isNotNull(paymentGatewayAccounts.credentialsSealed),
        ),
      );
    if (!account) return null;
    const provider = this.opened(account.organizationId, String(account.sealed));
    return provider === null ? null : { provider, organizationId: account.organizationId };
  }

  /** What a business pastes in Razorpay's webhook settings. */
  webhookUrl(webhookRef: string): string {
    return `${this.options.publicApiUrl}${WEBHOOK_PATH}/razorpay/${webhookRef}`;
  }
}
