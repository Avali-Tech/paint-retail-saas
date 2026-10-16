import 'reflect-metadata';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import type { EarnRuleView } from '@paint/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { fieldError } from '../tax/tax-lookups.js';
import type { EarnRuleBody } from './earn-rules.schemas.js';

const { brands, loyaltyEarnRules } = schema;

const taken = () => new ConflictException('Another earn rule already has this name');

/**
 * Painter points earn rules (P2-M36, spec §6.5). Like the programme, they are
 * business-wide: anyone with loyalty:read sees them, and only members with
 * loyalty:manage who work at every store (owners, admins) change them. Rules
 * are switched off, never deleted, so a credit note can still weigh what an
 * older invoice's lines earned.
 */
@Injectable()
export class EarnRulesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Active rules first, then by name. */
  list(auth: AuthContext): Promise<EarnRuleView[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.rules(tx));
  }

  create(auth: AuthContext, input: EarnRuleBody): Promise<EarnRuleView> {
    return this.save(auth, input, async (tx) => {
      const [rule] = (await tx
        .insert(loyaltyEarnRules)
        .values({
          ...input,
          organizationId: auth.organization.id,
          createdByMemberId: auth.memberId,
        })
        .returning({ id: loyaltyEarnRules.id })) as [{ id: string }];
      return rule.id;
    });
  }

  update(auth: AuthContext, id: string, input: EarnRuleBody): Promise<EarnRuleView> {
    return this.save(auth, input, async (tx) => {
      const [rule] = await tx
        .update(loyaltyEarnRules)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(loyaltyEarnRules.id, id))
        .returning({ id: loyaltyEarnRules.id });
      if (!rule) throw new NotFoundException('Earn rule not found');
      return rule.id;
    });
  }

  /** Checks who and which brand, writes the rule, and answers with it; a name in use is a 409. */
  private save(
    auth: AuthContext,
    input: EarnRuleBody,
    write: (tx: Transaction) => Promise<string>,
  ): Promise<EarnRuleView> {
    this.requireAllStores(auth);
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.requireBrand(tx, input.brandId);
      try {
        return await this.one(tx, await write(tx));
      } catch (error) {
        if (isUniqueViolation(error, ['loyalty_earn_rules_organization_name_unique'])) {
          throw taken();
        }
        throw error;
      }
    });
  }

  private requireAllStores(auth: AuthContext): void {
    if (!auth.allStores) {
      throw new ForbiddenException('Only members who work at every store can change earn rules');
    }
  }

  private async requireBrand(tx: Transaction, brandId: string | null): Promise<void> {
    if (brandId === null) return;
    const [brand] = await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, brandId));
    if (!brand) throw fieldError('brandId', 'Unknown brand');
  }

  private async one(tx: Transaction, id: string): Promise<EarnRuleView> {
    const [rule] = (await this.rules(tx, id)) as [EarnRuleView];
    return rule;
  }

  private async rules(tx: Transaction, id?: string): Promise<EarnRuleView[]> {
    const rows = await tx
      .select({ rule: loyaltyEarnRules, brandName: brands.name })
      .from(loyaltyEarnRules)
      .leftJoin(brands, eq(brands.id, loyaltyEarnRules.brandId))
      .where(id === undefined ? undefined : eq(loyaltyEarnRules.id, id))
      .orderBy(desc(loyaltyEarnRules.isActive), asc(loyaltyEarnRules.name));
    return rows.map(({ rule, brandName }) => ({
      id: rule.id,
      name: rule.name,
      basis: rule.basis,
      points: rule.points,
      perPaise: rule.perPaise,
      perMillilitres: rule.perMillilitres,
      brand: rule.brandId === null ? null : { id: rule.brandId, name: String(brandName) },
      multiplierBps: rule.multiplierBps,
      validFrom: rule.validFrom,
      validUntil: rule.validUntil,
      isActive: rule.isActive,
      updatedAt: rule.updatedAt.toISOString(),
    }));
  }
}
