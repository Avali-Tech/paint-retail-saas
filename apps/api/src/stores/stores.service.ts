import 'reflect-metadata';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation, schema, withTenant, type DatabaseConnection } from '@paint/db';
import { canAccessStore, type StoreDirectoryEntry } from '@paint/shared';
import { eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { requireRoomFor } from '../platform/plan-limits.js';
import type { CreateStoreInput } from './stores.schemas.js';

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

  /** Creates a store. Members without all-store access are given access to what they create. */
  async create(auth: AuthContext, input: CreateStoreInput): Promise<Store> {
    const organizationId = auth.organization.id;
    try {
      return await withTenant(this.connection.db, organizationId, async (tx) => {
        await requireRoomFor(tx, organizationId, 'stores');
        const [store] = (await tx
          .insert(stores)
          .values({ ...input, organizationId })
          .returning(storeFields)) as [Store];
        if (!auth.allStores) {
          await tx
            .insert(memberStores)
            .values({ organizationId, memberId: auth.memberId, storeId: store.id });
        }
        return store;
      });
    } catch (error) {
      if (isUniqueViolation(error, ['stores_organization_code_unique'])) {
        throw new ConflictException(`Store code ${input.code} is already in use`);
      }
      throw error;
    }
  }
}
