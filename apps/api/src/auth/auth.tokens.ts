/** Injection token for AuthSettings. */
export const AUTH_SETTINGS = Symbol('AUTH_SETTINGS');

/** Injection token for the SmsSender used to deliver one-time codes. */
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface AuthSettings {
  /** Server secret for hashing one-time codes. */
  readonly secret: string;
  readonly sessionTtlMs: number;
  readonly otpTtlMs: number;
  /** Wrong guesses allowed per code before it is locked. */
  readonly otpMaxAttempts: number;
  /** Minimum wait before another code can be requested for the same phone. */
  readonly otpResendCooldownMs: number;
  /** Codes allowed per phone per hour. */
  readonly otpMaxPerHour: number;
}

export function authSettingsFrom(config: {
  authSecret: string;
  sessionTtlDays: number;
}): AuthSettings {
  return {
    secret: config.authSecret,
    sessionTtlMs: config.sessionTtlDays * 24 * 60 * 60 * 1000,
    otpTtlMs: 5 * 60 * 1000,
    otpMaxAttempts: 5,
    otpResendCooldownMs: 30 * 1000,
    otpMaxPerHour: 5,
  };
}
