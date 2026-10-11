import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  canAccessStore,
  financialYear,
  formatTaxDocumentNumber,
  stateCodeFromGstin,
  type DocumentSeriesView,
  type GstinProfileView,
  type SalesSettingsView,
} from '@paint/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import type {
  CreateSeriesInput,
  GstinProfileInput,
  ListSeriesQuery,
  SalesSettingsInput,
  UpdateSeriesInput,
} from './billing.schemas.js';
import { indiaToday } from './invoice-view.js';
import { bankOf, printFields } from './print-settings.js';

const { documentSeries, gstinProfiles, parties, salesSettings, stores } = schema;

const DEFAULT_SETTINGS: SalesSettingsView = {
  stockPostOn: 'invoice',
  walkInPartyId: null,
  quoteValidityDays: 15,
  partialMinAdvancePct: 0,
  defaultPriceMode: 'inclusive',
  billingLiveOn: null,
  cashNeedsRegister: true,
  registerVarianceAlertPaise: 0,
  invoiceBank: null,
  invoiceTerms: [],
};

const settingsFields = {
  stockPostOn: salesSettings.stockPostOn,
  walkInPartyId: salesSettings.walkInPartyId,
  quoteValidityDays: salesSettings.quoteValidityDays,
  partialMinAdvancePct: salesSettings.partialMinAdvancePct,
  defaultPriceMode: salesSettings.defaultPriceMode,
  billingLiveOn: salesSettings.billingLiveOn,
  cashNeedsRegister: salesSettings.cashNeedsRegister,
  registerVarianceAlertPaise: salesSettings.registerVarianceAlertPaise,
  ...printFields,
};

const seriesFields = {
  id: documentSeries.id,
  storeId: documentSeries.storeId,
  kind: documentSeries.kind,
  prefix: documentSeries.prefix,
  digits: documentSeries.digits,
  isActive: documentSeries.isActive,
};
type SeriesRow = Omit<DocumentSeriesView, 'sample'>;

/** Selling settings, document series and per-GSTIN profiles (spec §3.3, §5.1). */
@Injectable()
export class BillingSettingsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  settings(auth: AuthContext): Promise<SalesSettingsView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.settingsIn(tx));
  }

  updateSettings(auth: AuthContext, input: SalesSettingsInput): Promise<SalesSettingsView> {
    if (input.billingLiveOn !== undefined) {
      throw fieldError(
        'billingLiveOn',
        'Billing goes live once, with its opening balances: POST /sales/go-live',
      );
    }
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (input.walkInPartyId) {
        const [party] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.id, input.walkInPartyId),
              eq(parties.isActive, true),
              isNull(parties.mergedIntoId),
            ),
          );
        if (!party) throw fieldError('walkInPartyId', 'Unknown customer');
      }
      const { invoiceBank, ...rest } = input;
      const values = {
        ...rest,
        ...(invoiceBank !== undefined && {
          bankName: invoiceBank?.bankName ?? null,
          bankAccountName: invoiceBank?.accountName ?? null,
          bankAccountNumber: invoiceBank?.accountNumber ?? null,
          bankIfsc: invoiceBank?.ifsc ?? null,
          upiId: invoiceBank?.upiId ?? null,
        }),
      };
      await tx
        .insert(salesSettings)
        .values({ organizationId: auth.organization.id, ...values })
        .onConflictDoUpdate({
          target: salesSettings.organizationId,
          set: { ...values, updatedAt: sql`now()` },
        });
      return this.settingsIn(tx);
    });
  }

  listSeries(auth: AuthContext, query: ListSeriesQuery): Promise<DocumentSeriesView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx
        .select(seriesFields)
        .from(documentSeries)
        .where(
          and(
            auth.allStores ? undefined : inArray(documentSeries.storeId, [...auth.storeIds]),
            query.storeId ? eq(documentSeries.storeId, query.storeId) : undefined,
          ),
        )
        .orderBy(
          asc(documentSeries.storeId),
          asc(documentSeries.kind),
          asc(documentSeries.createdAt),
        );
      return this.withSamples(tx, rows);
    });
  }

  /** A new series replaces the store's active one for that kind. */
  createSeries(auth: AuthContext, input: CreateSeriesInput): Promise<DocumentSeriesView> {
    if (!canAccessStore(auth, input.storeId)) throw new NotFoundException('Store not found');
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [store] = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.id, input.storeId));
      if (!store) throw new NotFoundException('Store not found');
      await tx
        .update(documentSeries)
        .set({ isActive: false, updatedAt: sql`now()` })
        .where(
          and(
            eq(documentSeries.storeId, input.storeId),
            eq(documentSeries.kind, input.kind),
            eq(documentSeries.isActive, true),
          ),
        );
      const rows = await tx
        .insert(documentSeries)
        .values({ organizationId: auth.organization.id, ...input })
        .returning(seriesFields);
      const [view] = (await this.withSamples(tx, rows)) as [DocumentSeriesView];
      return view;
    });
  }

  /** Switches a series on or off; only one per store and kind can be on. */
  updateSeries(
    auth: AuthContext,
    id: string,
    input: UpdateSeriesInput,
  ): Promise<DocumentSeriesView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [series] = await tx
        .select(seriesFields)
        .from(documentSeries)
        .where(eq(documentSeries.id, id));
      if (!series || !canAccessStore(auth, series.storeId)) {
        throw new NotFoundException('Series not found');
      }
      if (input.isActive) {
        const [other] = await tx
          .select({ id: documentSeries.id })
          .from(documentSeries)
          .where(
            and(
              eq(documentSeries.storeId, series.storeId),
              eq(documentSeries.kind, series.kind),
              eq(documentSeries.isActive, true),
              ne(documentSeries.id, id),
            ),
          );
        if (other) {
          throw new ConflictException(
            'Another series for this store and kind is active; switch it off first',
          );
        }
      }
      const rows = await tx
        .update(documentSeries)
        .set({ isActive: input.isActive, updatedAt: sql`now()` })
        .where(eq(documentSeries.id, id))
        .returning(seriesFields);
      const [view] = (await this.withSamples(tx, rows)) as [DocumentSeriesView];
      return view;
    });
  }

  /** One profile per GSTIN the business's stores are registered under (defaults when unset). */
  gstinProfiles(auth: AuthContext): Promise<GstinProfileView[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.profilesIn(tx));
  }

  updateGstinProfile(
    auth: AuthContext,
    gstin: string,
    input: GstinProfileInput,
  ): Promise<GstinProfileView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const profile = (await this.profilesIn(tx)).find((candidate) => candidate.gstin === gstin);
      if (!profile) throw new NotFoundException('No store is registered under this GSTIN');
      await tx
        .insert(gstinProfiles)
        .values({ organizationId: auth.organization.id, gstin, ...input })
        .onConflictDoUpdate({
          target: [gstinProfiles.organizationId, gstinProfiles.gstin],
          set: { ...input, updatedAt: sql`now()` },
        });
      return { ...profile, ...input };
    });
  }

  // Helpers -----------------------------------------------------------------

  private async settingsIn(tx: Transaction): Promise<SalesSettingsView> {
    const [row] = await tx.select(settingsFields).from(salesSettings);
    if (!row) return DEFAULT_SETTINGS;
    const { bankName, bankAccountName, bankAccountNumber, bankIfsc, upiId, ...settings } = row;
    return {
      ...settings,
      invoiceBank: bankOf({ bankName, bankAccountName, bankAccountNumber, bankIfsc, upiId }),
    };
  }

  private async withSamples(tx: Transaction, rows: SeriesRow[]): Promise<DocumentSeriesView[]> {
    const fy = financialYear(await indiaToday(tx));
    return rows.map((row) => ({
      ...row,
      sample: formatTaxDocumentNumber(row.prefix, fy, 1, row.digits),
    }));
  }

  private async profilesIn(tx: Transaction): Promise<GstinProfileView[]> {
    const rows = await tx
      .selectDistinct({
        gstin: sql<string>`${stores.gstin}`,
        aatoBand: sql<
          GstinProfileView['aatoBand']
        >`coalesce(${gstinProfiles.aatoBand}, 'up_to_5cr')`,
        einvoiceRequiredFrom: sql<string | null>`${gstinProfiles.einvoiceRequiredFrom}::text`,
        ewayThresholdPaise:
          sql<number>`coalesce(${gstinProfiles.ewayThresholdPaise}, 5000000)::bigint`.mapWith(
            Number,
          ),
      })
      .from(stores)
      .leftJoin(gstinProfiles, eq(gstinProfiles.gstin, stores.gstin))
      .where(and(ne(stores.registrationType, 'unregistered'), sql`${stores.gstin} is not null`))
      .orderBy(sql`1`);
    return rows.map((row) => ({ ...row, stateCode: stateCodeFromGstin(row.gstin) }));
  }
}
