import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL of the PostgreSQL started once for the whole integration run. */
    databaseUrl: string;
  }
}
