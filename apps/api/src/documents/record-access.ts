import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { canAccessStore, type Permission } from '@paint/shared';
import { eq } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

const {
  contracts,
  goodsReceipts,
  leads,
  opportunities,
  parties,
  products,
  projects,
  purchaseOrders,
  stockCounts,
  stores,
  transfers,
} = schema;

export const RECORD_TYPES = schema.documentRecordType.enumValues;
export type RecordType = (typeof RECORD_TYPES)[number];

interface RecordRule {
  readonly read: Permission;
  readonly manage: Permission;
  /**
   * The stores the record belongs to (empty = the whole business), or null if
   * there is no such record. Members see it if they work at any of them.
   */
  stores(tx: Transaction, id: string): Promise<string[] | null>;
}

const first = async <T>(rows: Promise<T[]>) => (await rows)[0];

/** Who may see and change each kind of record — and so what is attached to it. */
const RULES: Record<RecordType, RecordRule> = {
  party: {
    read: 'parties:read',
    manage: 'parties:manage',
    stores: async (tx, id) => {
      const party = await first(
        tx.select({ homeStoreId: parties.homeStoreId }).from(parties).where(eq(parties.id, id)),
      );
      return party ? (party.homeStoreId ? [party.homeStoreId] : []) : null;
    },
  },
  product: {
    read: 'catalog:read',
    manage: 'catalog:manage',
    stores: async (tx, id) =>
      (await first(tx.select({ id: products.id }).from(products).where(eq(products.id, id))))
        ? []
        : null,
  },
  store: {
    read: 'stores:read',
    manage: 'stores:manage',
    stores: async (tx, id) =>
      (await first(tx.select({ id: stores.id }).from(stores).where(eq(stores.id, id))))
        ? [id]
        : null,
  },
  purchase_order: {
    read: 'purchasing:read',
    manage: 'purchasing:manage',
    stores: async (tx, id) => {
      const order = await first(
        tx
          .select({ storeId: purchaseOrders.storeId })
          .from(purchaseOrders)
          .where(eq(purchaseOrders.id, id)),
      );
      return order ? [order.storeId] : null;
    },
  },
  goods_receipt: {
    read: 'purchasing:read',
    manage: 'purchasing:manage',
    stores: async (tx, id) => {
      const receipt = await first(
        tx
          .select({ storeId: goodsReceipts.storeId })
          .from(goodsReceipts)
          .where(eq(goodsReceipts.id, id)),
      );
      return receipt ? [receipt.storeId] : null;
    },
  },
  transfer: {
    read: 'inventory:read',
    manage: 'inventory:manage',
    stores: async (tx, id) => {
      const transfer = await first(
        tx
          .select({ from: transfers.fromStoreId, to: transfers.toStoreId })
          .from(transfers)
          .where(eq(transfers.id, id)),
      );
      return transfer ? [transfer.from, transfer.to] : null;
    },
  },
  lead: {
    read: 'leads:read',
    manage: 'leads:manage',
    stores: async (tx, id) => {
      const lead = await first(
        tx.select({ storeId: leads.storeId }).from(leads).where(eq(leads.id, id)),
      );
      return lead ? [lead.storeId] : null;
    },
  },
  opportunity: {
    read: 'leads:read',
    manage: 'leads:manage',
    stores: async (tx, id) => {
      const opportunity = await first(
        tx
          .select({ storeId: opportunities.storeId })
          .from(opportunities)
          .where(eq(opportunities.id, id)),
      );
      return opportunity ? [opportunity.storeId] : null;
    },
  },
  project: {
    read: 'projects:read',
    manage: 'projects:manage',
    stores: async (tx, id) => {
      const project = await first(
        tx.select({ storeId: projects.storeId }).from(projects).where(eq(projects.id, id)),
      );
      return project ? [project.storeId] : null;
    },
  },
  contract: {
    read: 'contracts:read',
    manage: 'contracts:manage',
    stores: async (tx, id) => {
      const contract = await first(
        tx.select({ storeId: contracts.storeId }).from(contracts).where(eq(contracts.id, id)),
      );
      return contract ? (contract.storeId ? [contract.storeId] : []) : null;
    },
  },
  stock_count: {
    read: 'inventory:read',
    manage: 'inventory:manage',
    stores: async (tx, id) => {
      const count = await first(
        tx.select({ storeId: stockCounts.storeId }).from(stockCounts).where(eq(stockCounts.id, id)),
      );
      return count ? [count.storeId] : null;
    },
  },
};

/**
 * Checks the member may see (`read`) or change (`manage`) the record and what is
 * attached to it, and returns the stores it belongs to (empty = business-wide):
 * 403 without the record's permission, 404 if the record does not exist or
 * belongs to stores they do not work at.
 */
export async function requireRecordAccess(
  tx: Transaction,
  auth: AuthContext,
  recordType: RecordType,
  recordId: string,
  need: 'read' | 'manage',
  /** What is being checked, for the message. */
  what = 'documents',
): Promise<string[]> {
  const rule = RULES[recordType];
  if (!auth.permissions.has(rule[need])) {
    throw new ForbiddenException(
      need === 'read'
        ? `You cannot see ${what} on this record`
        : `You cannot change ${what} on this record`,
    );
  }
  const storeIds = await rule.stores(tx, recordId);
  if (!storeIds || (storeIds.length > 0 && !storeIds.some((id) => canAccessStore(auth, id)))) {
    throw new NotFoundException('Record not found');
  }
  return storeIds;
}

/** The permissions that let someone see and change a kind of record. */
export function recordPermissions(recordType: RecordType): {
  read: Permission;
  manage: Permission;
} {
  const { read, manage } = RULES[recordType];
  return { read, manage };
}
