import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL of the PostgreSQL started once for the whole integration run. */
    databaseUrl: string;
    /** http:// URL of the S3-compatible object store started for the run. */
    objectStorageEndpoint: string;
    /** host:port of the ClamAV daemon started for the run. */
    virusScannerAddress: string;
    /** smtp:// URL of the mail catcher started for the run. */
    mailSmtpUrl: string;
    /** http:// URL of the mail catcher's API. */
    mailApiUrl: string;
  }
}
