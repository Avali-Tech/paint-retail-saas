import { z } from 'zod';

/** Where and how errors are reported. Off (null) unless SENTRY_DSN is set. */
export interface ErrorTrackingSettings {
  readonly dsn: string;
  /** "production", "staging"…: defaults to NODE_ENV. */
  readonly environment: string;
  /** The deployed version (the git commit), so errors can be matched to a build. */
  readonly release: string | null;
}

const blankAsUnset = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
  SENTRY_DSN: z.preprocess(blankAsUnset, z.url({ protocol: /^https?$/ }).optional()),
  SENTRY_ENVIRONMENT: z.preprocess(blankAsUnset, z.string().min(1).optional()),
  SENTRY_RELEASE: z.preprocess(blankAsUnset, z.string().min(1).optional()),
  NODE_ENV: z.string().default('development'),
});

/** Reads the SENTRY_* variables. Throws without echoing the DSN, which contains a key. */
export function errorTrackingSettings(
  env: Record<string, string | undefined>,
): ErrorTrackingSettings | null {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid error tracking settings: ${fields.join(', ')}`);
  }
  const { SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_RELEASE, NODE_ENV } = result.data;
  if (SENTRY_DSN === undefined) return null;
  return {
    dsn: SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT ?? NODE_ENV,
    release: SENTRY_RELEASE ?? null,
  };
}
