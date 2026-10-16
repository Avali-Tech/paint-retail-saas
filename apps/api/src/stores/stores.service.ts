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
import { canAccessStore, type StoreDirectoryEntry } from '@paint/shared';
import { and, count, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { requireRoomFor } from '../platform/plan-limits.js';
import { applyStoreRegistration } from '../tax/gst-registrations.service.js';
import type { CreateStoreInput, UpdateStoreInput } from './stores.schemas.js';

const { memberStores, stores } = schema;

const storeFields = {
  id: stores.id,
  name: stores.name,
  code: stores.code,
  type: stores.type,
  city: stores.city,
  state: stores.state,
  gstin: stores.gstin,
  isActive: stores.isActive,
};

export interface Store {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly type: 'store' | 'godown';
  readonly city: string | null;
  readonly state: string | null;
  readonly gstin: string | null;
  readonly isActive: boolean;
}

@Injectable()
export class StoresService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Stores the member can access, ordered by code. */
  list(auth: AuthContext): Promise<Store[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      tx
        .select(storeFields)
        .from(stores)
        .where(auth.allStores ? undefined : inArray(stores.id, [...auth.storeIds]))
        .orderBy(stores.code),
    );
  }

  /**
   * Every open store of the business with just its code and name, whatever
   * the member's own access: for pickers such as which store to ask for stock.
   */
  directory(auth: AuthContext): Promise<StoreDirectoryEntry[]> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      tx
        .select({ id: stores.id, code: stores.code, name: stores.name })
        .from(stores)
        .where(eq(stores.isActive, true))
        .orderBy(stores.code),
    );
  }

  /** One store; 404 when it doesn't exist or the member can't access it (no difference is revealed). */
  async get(auth: AuthContext, id: string): Promise<Store> {
    if (!canAccessStore(auth, id)) throw new NotFoundException('Store not found');
    const [store] = await withTenant(this.connection.db, auth.organization.id, (tx) =>
      tx.select(storeFields).from(stores).where(eq(stores.id, id)),
    );
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  /**
   * Creates a store, with its GST registration when given (in one go). Members
   * without all-store access are given access to what they create; those who
   * work at every store see it at once. Its document series are set up with
   * its first document of each kind (billing/series.ts).
   */
  async create(auth: AuthContext, input: CreateStoreInput): Promise<Store> {
    const organizationId = auth.organization.id;
    const { registration, ...fields } = input;
    if (registration && !auth.permissions.has('tax:manage')) {
      throw new ForbiddenException('You cannot set GST registrations');
    }
    try {
      return await withTenant(this.connection.db, organizationId, async (tx) => {
        await requireRoomFor(tx, organizationId, 'stores');
        const [created] = (await tx
          .insert(stores)
          .values({ ...fields, organizationId })
          .returning({ id: stores.id })) as [{ id: string }];
        if (!auth.allStores) {
          await tx
            .insert(memberStores)
            .values({ organizationId, memberId: auth.memberId, storeId: created.id });
        }
        if (registration) await applyStoreRegistration(tx, auth, created.id, registration);
        return this.read(tx, created.id);
      });
    } catch (error) {
      if (isUniqueViolation(error, ['stores_organization_code_unique'])) {
        throw new ConflictException(`Store code ${input.code} is already in use`);
      }
      throw error;
    }
  }

  /**
   * Renames a store, changes its kind, or closes or reopens it. Documents
   * already issued keep the details printed on them. A business keeps at
   * least one open store, and reopening one counts against the plan.
   */
  async update(auth: AuthContext, id: string, input: UpdateStoreInput): Promise<Store> {
    if (!canAccessStore(auth, id)) throw new NotFoundException('Store not found');
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [current] = await tx
        .select({ isActive: stores.isActive })
        .from(stores)
        .where(eq(stores.id, id))
        .for('update');
      if (!current) throw new NotFoundException('Store not found');
      if (input.isActive === true && !current.isActive) {
        await requireRoomFor(tx, auth.organization.id, 'stores');
      }
      if (input.isActive === false && current.isActive) {
        // Serialise closing stores, so two at once cannot close the last two.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`stores:${auth.organization.id}`}, 0))`,
        );
        const [open] = await tx
          .select({ n: count() })
          .from(stores)
          .where(and(eq(stores.isActive, true), ne(stores.id, id)));
        if (Number(open?.n) === 0) {
          throw new ConflictException('Keep at least one store open');
        }
      }
      await tx
        .update(stores)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(stores.id, id));
      return this.read(tx, id);
    });
  }

  private async read(tx: Transaction, id: string): Promise<Store> {
    const [store] = (await tx.select(storeFields).from(stores).where(eq(stores.id, id))) as [Store];
    return store;
  }
}
