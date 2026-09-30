import { sql } from 'drizzle-orm';
import type { Database } from './client.js';

/** The transaction handle passed to work inside withTenant. */
export type TenantTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless `organizationId` is a UUID. */
export function assertOrganizationId(organizationId: string): void {
  if (!UUID.test(organizationId)) {
    throw new TypeError(`Organisation id must be a UUID, got "${organizationId}"`);
  }
}

/**
 * Runs `work` in a transaction that can only see and change rows belonging to
 * `organizationId`. PostgreSQL row-level security enforces this, so a missing
 * WHERE clause can never leak another organisation's data.
 *
 * The organisation and role are set with SET LOCAL semantics: they end with the
 * transaction and never leak to the next query on the same pooled connection.
 */
export async function withTenant<T>(
  db: Database,
  organizationId: string,
  work: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  assertOrganizationId(organizationId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_organization_id', ${organizationId}, true)`,
    );
    await tx.execute(sql`set local role app_tenant`);
    return work(tx);
  });
}
