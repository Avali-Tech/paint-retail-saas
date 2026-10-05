import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { schema, type DatabaseConnection, type Transaction } from '@paint/db';
import type { PendingSignIn, TwoFactorError, TwoFactorErrorCode } from '@paint/shared';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { AUTH_SETTINGS, type AuthSettings } from './auth.tokens.js';
import { digestsEqual, generateSessionToken, hashSessionToken } from './credentials.js';
import {
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  openSecret,
  otpauthUri,
  sealSecret,
  verifyTotp,
} from './totp.js';

const { twoFactorChallenges, userRecoveryCodes, userTotp, users } = schema;

export interface Enrolment {
  /** Base32, for typing into the app by hand. */
  readonly secret: string;
  /** otpauth:// URI, shown as a QR code. */
  readonly otpauthUri: string;
}

const INVALID = 'Invalid or expired sign-in';
const WRONG_CODE = 'Wrong code';
const TOO_MANY = 'Too many wrong codes. Sign in again.';
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

const MESSAGES: Record<TwoFactorErrorCode, string> = {
  wrong_code: WRONG_CODE,
  expired: INVALID,
  too_many_attempts: TOO_MANY,
};

/** A refused two-factor step: 401 with a machine-readable `code` beside the message. */
export function twoFactorRefusal(
  code: TwoFactorErrorCode,
  attemptsRemaining?: number,
): UnauthorizedException {
  const body: TwoFactorError = {
    statusCode: 401,
    message: MESSAGES[code],
    code,
    ...(attemptsRemaining === undefined ? {} : { attemptsRemaining }),
  };
  return new UnauthorizedException(body);
}

/**
 * Two-factor sign-in with an authenticator app (TOTP): enrolment, recovery
 * codes, and the short-lived challenge between the first and second step.
 * Platform scope: works on people, not businesses.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  /** Whether the person has a confirmed authenticator, and how many recovery codes are left. */
  async status(userId: string): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
    const { db } = this.connection;
    const [totp] = await db
      .select({ confirmedAt: userTotp.confirmedAt })
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)));
    const left = await db
      .select({ id: userRecoveryCodes.id })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
    return { enabled: totp !== undefined, recoveryCodesLeft: left.length };
  }

  /** What the authenticator app shows the account as: the email, or else the mobile number. */
  async accountLabel(userId: string): Promise<string> {
    const [user] = await this.connection.db
      .select({ email: users.email, phone: users.phone })
      .from(users)
      .where(eq(users.id, userId));
    return String(user?.email ?? user?.phone);
  }

  /** Starts (or restarts) adding an authenticator; refused once one is confirmed. */
  async startEnrolment(userId: string, account: string, issuer: string): Promise<Enrolment> {
    if ((await this.status(userId)).enabled) {
      throw new ConflictException('Two-factor sign-in is already on');
    }
    const secret = generateTotpSecret();
    const secretCiphertext = sealSecret(this.settings.secret, secret);
    await this.connection.db
      .insert(userTotp)
      .values({ userId, secretCiphertext })
      .onConflictDoUpdate({
        target: userTotp.userId,
        set: { secretCiphertext, lastUsedStep: null, createdAt: sql`now()` },
      });
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(issuer, account, secret) };
  }

  /** Confirms the authenticator with a code from it, and returns fresh recovery codes. */
  confirmEnrolment(userId: string, code: string): Promise<string[]> {
    return this.connection.db.transaction(async (tx) => {
      const [totp] = await tx
        .select()
        .from(userTotp)
        .where(and(eq(userTotp.userId, userId), isNull(userTotp.confirmedAt)))
        .for('update');
      if (!totp) throw new ConflictException('Start adding an authenticator app first');
      const step = verifyTotp(
        openSecret(this.settings.secret, totp.secretCiphertext),
        code,
        Date.now(),
        null,
      );
      if (step === null) throw new BadRequestException(WRONG_CODE);
      await tx
        .update(userTotp)
        .set({ confirmedAt: sql`now()`, lastUsedStep: step })
        .where(eq(userTotp.userId, userId));
      return this.replaceRecoveryCodes(tx, userId);
    });
  }

  /** New recovery codes, replacing the old ones; needs a current code. */
  regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    return this.connection.db.transaction(async (tx) => {
      if (!(await this.checkCode(tx, userId, code))) throw new BadRequestException(WRONG_CODE);
      return this.replaceRecoveryCodes(tx, userId);
    });
  }

  /** Turns two-factor sign-in off for the person, after checking a current code. */
  disable(userId: string, code: string): Promise<void> {
    return this.connection.db.transaction(async (tx) => {
      if (!(await this.checkCode(tx, userId, code))) throw new BadRequestException(WRONG_CODE);
      await this.remove(tx, userId);
    });
  }

  /** Removes the authenticator and recovery codes (an owner's reset, or turning it off). */
  async remove(tx: Transaction, userId: string): Promise<void> {
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx.delete(userTotp).where(eq(userTotp.userId, userId));
  }

  /** Issues the second-step token after a correct password or SMS code. */
  async challenge(
    userId: string,
    organizationId: string | null,
    setupRequired: boolean,
  ): Promise<PendingSignIn> {
    const pendingToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await this.connection.db.insert(twoFactorChallenges).values({
      tokenHash: hashSessionToken(pendingToken),
      userId,
      organizationId,
      expiresAt,
    });
    return { pendingToken, expiresAt: expiresAt.toISOString(), setupRequired };
  }

  /** The person a pending sign-in belongs to, while it is still usable. */
  async pending(pendingToken: string): Promise<{ userId: string; organizationId: string | null }> {
    const [challenge] = await this.openChallenges(this.connection.db, pendingToken);
    if (!challenge) throw await this.whyClosed(this.connection.db, pendingToken);
    return { userId: challenge.userId, organizationId: challenge.organizationId };
  }

  /**
   * Completes the second step: a TOTP code, a recovery code, or — while adding
   * the app — the first code from it, which confirms it and returns recovery
   * codes. Each wrong code uses up one of the token's tries; the token works once.
   */
  completeChallenge(
    pendingToken: string,
    code: string,
    isPlatform: boolean,
  ): Promise<{ userId: string; organizationId: string | null; recoveryCodes?: string[] }> {
    return this.connection.db
      .transaction(async (tx) => {
        const [challenge] = await this.openChallenges(tx, pendingToken).for('update');
        if (!challenge) throw await this.whyClosed(tx, pendingToken);
        if ((challenge.organizationId === null) !== isPlatform) throw twoFactorRefusal('expired');
        const [totp] = await tx
          .select({ confirmedAt: userTotp.confirmedAt })
          .from(userTotp)
          .where(eq(userTotp.userId, challenge.userId));
        let recoveryCodes: string[] | undefined;
        let correct: boolean;
        if (totp?.confirmedAt === null) {
          // Adding the app during sign-in: the first code confirms it.
          recoveryCodes = await this.confirmInside(tx, challenge.userId, code);
          correct = recoveryCodes !== undefined;
        } else {
          correct = await this.checkCode(tx, challenge.userId, code);
        }
        if (!correct) {
          await tx
            .update(twoFactorChallenges)
            .set({ attempts: sql`${twoFactorChallenges.attempts} + 1` })
            .where(eq(twoFactorChallenges.id, challenge.id));
          return { wrong: true as const, left: CHALLENGE_MAX_ATTEMPTS - challenge.attempts - 1 };
        }
        await tx
          .update(twoFactorChallenges)
          .set({ consumedAt: sql`now()` })
          .where(eq(twoFactorChallenges.id, challenge.id));
        return {
          wrong: false as const,
          signedIn: {
            userId: challenge.userId,
            organizationId: challenge.organizationId,
            ...(recoveryCodes ? { recoveryCodes } : {}),
          },
        };
      })
      .then((result) => {
        // Thrown after the transaction commits, so the wasted try is kept.
        if (!result.wrong) return result.signedIn;
        throw result.left > 0
          ? twoFactorRefusal('wrong_code', result.left)
          : twoFactorRefusal('too_many_attempts', 0);
      });
  }

  // Helpers -----------------------------------------------------------------

  /** Why a pending sign-in can no longer be used: its tries are used up, or it expired / was used / never existed. */
  private async whyClosed(
    db: Transaction | DatabaseConnection['db'],
    pendingToken: string,
  ): Promise<UnauthorizedException> {
    const [challenge] = await db
      .select({
        attempts: twoFactorChallenges.attempts,
        consumedAt: twoFactorChallenges.consumedAt,
      })
      .from(twoFactorChallenges)
      .where(eq(twoFactorChallenges.tokenHash, hashSessionToken(pendingToken)));
    return challenge?.consumedAt === null && challenge.attempts >= CHALLENGE_MAX_ATTEMPTS
      ? twoFactorRefusal('too_many_attempts', 0)
      : twoFactorRefusal('expired');
  }

  private openChallenges(db: Transaction | DatabaseConnection['db'], pendingToken: string) {
    return db
      .select()
      .from(twoFactorChallenges)
      .where(
        and(
          eq(twoFactorChallenges.tokenHash, hashSessionToken(pendingToken)),
          isNull(twoFactorChallenges.consumedAt),
          gt(twoFactorChallenges.expiresAt, sql`now()`),
          sql`${twoFactorChallenges.attempts} < ${CHALLENGE_MAX_ATTEMPTS}`,
        ),
      )
      .$dynamic();
  }

  /** Confirms an unconfirmed authenticator inside a transaction; undefined for a wrong code. */
  private async confirmInside(
    tx: Transaction,
    userId: string,
    code: string,
  ): Promise<string[] | undefined> {
    const [totp] = await tx
      .select()
      .from(userTotp)
      .where(eq(userTotp.userId, userId))
      .for('update');
    const step = verifyTotp(
      openSecret(this.settings.secret, String(totp?.secretCiphertext)),
      code,
      Date.now(),
      null,
    );
    if (step === null) return undefined;
    await tx
      .update(userTotp)
      .set({ confirmedAt: sql`now()`, lastUsedStep: step })
      .where(eq(userTotp.userId, userId));
    return this.replaceRecoveryCodes(tx, userId);
  }

  /** Accepts a TOTP code from a confirmed authenticator, or an unused recovery code (once). */
  private async checkCode(tx: Transaction, userId: string, code: string): Promise<boolean> {
    const [totp] = await tx
      .select()
      .from(userTotp)
      .where(and(eq(userTotp.userId, userId), isNotNull(userTotp.confirmedAt)))
      .for('update');
    if (!totp) return false;
    const step = verifyTotp(
      openSecret(this.settings.secret, totp.secretCiphertext),
      code.trim(),
      Date.now(),
      totp.lastUsedStep,
    );
    if (step !== null) {
      await tx.update(userTotp).set({ lastUsedStep: step }).where(eq(userTotp.userId, userId));
      return true;
    }
    const hash = hashRecoveryCode(this.settings.secret, code);
    const unused = await tx
      .select({ id: userRecoveryCodes.id, codeHash: userRecoveryCodes.codeHash })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)))
      .for('update');
    const match = unused.find((row) => digestsEqual(row.codeHash, hash));
    if (!match) return false;
    await tx
      .update(userRecoveryCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(userRecoveryCodes.id, match.id));
    return true;
  }

  private async replaceRecoveryCodes(tx: Transaction, userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx
      .insert(userRecoveryCodes)
      .values(
        codes.map((code) => ({ userId, codeHash: hashRecoveryCode(this.settings.secret, code) })),
      );
    return codes;
  }
}
