export {
  createDatabase,
  type Database,
  type DatabaseConnection,
  type DatabaseOptions,
  type Transaction,
} from './client.js';
export { isCheckViolation, isUniqueViolation, uniqueViolationConstraint } from './errors.js';
export { MIGRATIONS_FOLDER, migrateDatabase } from './migrate.js';
export * as schema from './schema.js';
export { nextDocumentNumber } from './sequences.js';
export {
  InsufficientStockError,
  findStockMismatches,
  postStockMovements,
  type StockMismatch,
  type StockMovement,
  type StockMovementType,
} from './stock.js';
export {
  assertOrganizationId,
  enterTenantScope,
  withTenant,
  type TenantTransaction,
} from './tenant.js';
export { sql } from 'drizzle-orm';
