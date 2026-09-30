// Makes inject('databaseUrl') typed for every package that uses these helpers.
import type {} from './vitest-context.js';

export { POSTGRES_IMAGE, startTestDatabase, type TestDatabase } from './postgres.js';
export { createIsolatedDatabase } from './isolated-database.js';
export { withPgClient } from './pg-client.js';
