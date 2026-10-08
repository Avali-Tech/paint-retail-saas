import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { DEFAULT_PAYMENT_MODES, type PaymentModeView } from '@paint/shared';
import { asc, eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import type { CreatePaymentModeInput, UpdatePaymentModeInput } from './payments.schemas.js';

const { paymentModes } = schema;

const fields = {
  id: paymentModes.id,
  kind: paymentModes.kind,
  name: paymentModes.name,
  isActive: paymentModes.isActive,
};

/** A name already in use, as a 409. */
const taken = () => new ConflictException('A payment mode with this name already exists');

/** How the business takes money (spec §3.3): the five base modes, plus its own. */
@Injectable()
export class PaymentModesService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Every mode, in use first; a business without any gets the base five. */
  list(auth: AuthContext): Promise<PaymentModeView[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.seed(tx, auth.organization.id);
      return tx
        .select(fields)
        .from(paymentModes)
        .orderBy(
          sql`${paymentModes.isActive} desc`,
          asc(paymentModes.kind),
          asc(paymentModes.name),
        );
    });
  }

  create(auth: AuthContext, input: CreatePaymentModeInput): Promise<PaymentModeView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await this.seed(tx, auth.organization.id);
      const [mode] = await tx
        .insert(paymentModes)
        .values({ organizationId: auth.organization.id, ...input })
        .onConflictDoNothing()
        .returning(fields);
      if (!mode) throw taken();
      return mode;
    });
  }

  /** Renames a mode or switches it off; payments already taken keep it. */
  update(auth: AuthContext, id: string, input: UpdatePaymentModeInput): Promise<PaymentModeView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      try {
        const [mode] = await tx
          .update(paymentModes)
          .set({ ...input, updatedAt: sql`now()` })
          .where(eq(paymentModes.id, id))
          .returning(fields);
        if (!mode) throw new NotFoundException('Payment mode not found');
        return mode;
      } catch (error) {
        if (isUniqueViolation(error, ['payment_modes_name_unique'])) throw taken();
        throw error;
      }
    });
  }

  private async seed(tx: Transaction, organizationId: string): Promise<void> {
    const [any] = await tx.select({ id: paymentModes.id }).from(paymentModes).limit(1);
    if (any) return;
    await tx
      .insert(paymentModes)
      .values(DEFAULT_PAYMENT_MODES.map((mode) => ({ organizationId, ...mode })))
      .onConflictDoNothing();
  }
}
