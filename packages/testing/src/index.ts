// Makes inject('databaseUrl') typed for every package that uses these helpers.
import type {} from './vitest-context.js';

export {
  MAX_LOCKS_PER_TRANSACTION,
  POSTGRES_IMAGE,
  startTestDatabase,
  type TestDatabase,
} from './postgres.js';
export { createIsolatedDatabase } from './isolated-database.js';
export { MAIL_SERVER_IMAGE, startTestMailServer, type TestMailServer } from './mail-server.js';
export {
  OBJECT_STORAGE_IMAGE,
  startTestObjectStorage,
  type TestObjectStorage,
} from './object-storage.js';
export {
  VIRUS_SCANNER_IMAGE,
  startTestVirusScanner,
  type TestVirusScanner,
} from './virus-scanner.js';
export { withPgClient } from './pg-client.js';
