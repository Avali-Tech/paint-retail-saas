import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { taxRateOn, type TaxCategoryOptions, type TaxCategoryView } from '@paint/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError, indiaToday, isGstRegistered } from './tax-lookups.js';
import type {
  AddTaxRateInput,
  CreateTaxCategoryInput,
  UpdateTaxCategoryInput,
} from './tax.schemas.js';

const { taxCategories, taxRates } = schema;

const DUPLICATE_NAME = 'A tax category with this name already exists';

/** Tax categories and their rate history (Settings, Tax & GST). */
@Injectable()
export class TaxService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Every category with its full rate history, active ones first, by name. */
  list(auth: AuthContext): Promise<TaxCategoryView[]> {
    return this.tenant(auth, (tx) => this.views(tx));
  }

  /** Active categories with today's rate, for the product form. */
  options(auth: AuthContext): Promise<TaxCategoryOptions> {
    return this.tenant(auth, async (tx) => ({
      gstRegistered: await isGstRegistered(tx),
      categories: (await this.views(tx))
        .filter((category) => category.isActive)
        .map(({ id, key, name, isDefault, currentRateBps }) => ({
          id,
          key,
          name,
          isDefault,
          currentRateBps,
        })),
    }));
  }

  create(auth: AuthContext, input: CreateTaxCategoryInput): Promise<TaxCategoryView> {
    return this.tenant(auth, async (tx) => {
      const organizationId = auth.organization.id;
      const [category] = await tx
        .insert(taxCategories)
        .values({ organizationId, name: input.name })
        .returning({ id: taxCategories.id });
      const id = String(category?.id);
      await tx.insert(taxRates).values({
        organizationId,
        taxCategoryId: id,
        rateBps: input.rateBps,
        effectiveFrom: input.effectiveFrom ?? sql`${indiaToday}`,
      });
      return this.view(tx, id);
    });
  }

  /** Renames, deactivates or reactivates a category, or makes it the default. */
  update(
    auth: AuthContext,
    categoryId: string,
    input: UpdateTaxCategoryInput,
  ): Promise<TaxCategoryView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.view(tx, categoryId);
      const willBeActive = input.isActive ?? current.isActive;
      if (current.isDefault && !willBeActive) {
        throw fieldError('isActive', 'Make another category the default first');
      }
      if (input.isDefault && !willBeActive) {
        throw fieldError('isDefault', 'An inactive category cannot be the default');
      }
      if (input.isDefault) {
        await tx
          .update(taxCategories)
          .set({ isDefault: false, updatedAt: sql`now()` })
          .where(and(eq(taxCategories.isDefault, true), ne(taxCategories.id, categoryId)));
      }
      await tx
        .update(taxCategories)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(taxCategories.id, categoryId));
      return this.view(tx, categoryId);
    });
  }

  /**
   * Adds the next rate. It starts today or later (India time) and after the last
   * one, whose period then ends the day before. Past rates never change.
   */
  addRate(auth: AuthContext, categoryId: string, input: AddTaxRateInput): Promise<TaxCategoryView> {
    return this.tenant(auth, async (tx) => {
      await this.view(tx, categoryId);
      // Two rates added at once must not both close the same period.
      await tx
        .select({ id: taxCategories.id })
        .from(taxCategories)
        .where(eq(taxCategories.id, categoryId))
        .for('update');
      const [check] = await tx
        .select({
          beforeToday: sql<boolean>`${input.effectiveFrom}::date < ${indiaToday}`,
          latest: sql<string>`max(${taxRates.effectiveFrom})::text`,
        })
        .from(taxRates)
        .where(eq(taxRates.taxCategoryId, categoryId));
      if (check?.beforeToday) {
        throw fieldError(
          'effectiveFrom',
          'A new rate starts today or later; past rates stay as they were',
        );
      }
      const latest = String(check?.latest);
      if (input.effectiveFrom <= latest) {
        throw fieldError('effectiveFrom', `A new rate must start after ${latest}`);
      }
      await tx
        .update(taxRates)
        .set({ effectiveTo: sql`${input.effectiveFrom}::date - 1` })
        .where(and(eq(taxRates.taxCategoryId, categoryId), isNull(taxRates.effectiveTo)));
      await tx.insert(taxRates).values({
        organizationId: auth.organization.id,
        taxCategoryId: categoryId,
        rateBps: input.rateBps,
        effectiveFrom: input.effectiveFrom,
      });
      return this.view(tx, categoryId);
    });
  }

  private async tenant<T>(auth: AuthContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.connection.db, auth.organization.id, work);
    } catch (error) {
      if (isUniqueViolation(error, ['tax_categories_organization_name_unique'])) {
        throw new ConflictException(DUPLICATE_NAME);
      }
      throw error;
    }
  }

  private async view(tx: Transaction, categoryId: string): Promise<TaxCategoryView> {
    const [view] = await this.views(tx, [categoryId]);
    if (!view) throw new NotFoundException('Tax category not found');
    return view;
  }

  private async views(tx: Transaction, ids?: string[]): Promise<TaxCategoryView[]> {
    const {
      rows: [today],
    } = await tx.execute<{ today: string }>(sql`select ${indiaToday}::text as today`);
    const categories = await tx
      .select()
      .from(taxCategories)
      .where(ids ? inArray(taxCategories.id, ids) : undefined)
      .orderBy(sql`${taxCategories.isActive} desc`, sql`lower(${taxCategories.name})`);
    const rates = await tx
      .select()
      .from(taxRates)
      .where(
        inArray(
          taxRates.taxCategoryId,
          categories.map((category) => category.id),
        ),
      )
      .orderBy(asc(taxRates.effectiveFrom));
    return categories.map((category) => {
      const history = rates
        .filter((rate) => rate.taxCategoryId === category.id)
        .map(({ id, rateBps, effectiveFrom, effectiveTo }) => ({
          id,
          rateBps,
          effectiveFrom,
          effectiveTo,
        }));
      return {
        id: category.id,
        key: category.key,
        name: category.name,
        isDefault: category.isDefault,
        isActive: category.isActive,
        currentRateBps: taxRateOn(history, String(today?.today)),
        rates: history,
      };
    });
  }
}
