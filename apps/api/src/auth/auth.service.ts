import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isUniqueViolation, schema, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  isPermission,
  normalizeEmail,
  normalizePhone,
  type SessionGrant,
  type SignInResult,
  type TwoFactorSignIn,
} from '@paint/shared';
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import { setUpOrganization } from './organization-setup.js';
import type { AuthContext } from './auth-context.js';
import type {
  OtpRequestInput,
  OtpVerifyInput,
  PasswordLoginInput,
  SignupInput,
} from './auth.schemas.js';
import { AUTH_SETTINGS, SMS_SENDER, type AuthSettings } from './auth.tokens.js';
import {
  digestsEqual,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './credentials.js';
import type { SmsSender } from './sms.js';
import { TwoFactorService, type Enrolment } from './two-factor.service.js';

const {
  memberStores,
  organizationMembers,
  organizations,
  otpChallenges,
  rolePermissions,
  roles,
  sessions,
  supportAccessLog,
  supportGrants,
  users,
} = schema;

/** Same message for every sign-in failure, so responses never reveal who has an account. */
const INVALID_CREDENTIALS = 'Invalid sign-in details';

/** Roles a business can require two-factor sign-in of. */
export const TWO_FACTOR_ROLES: readonly string[] = ['owner', 'org_admin'];
/** How authenticator apps label the account. */
export const TOTP_ISSUER = 'Paint Retail';

export type { SessionGrant };

interface OrganizationChoice {
  readonly id: string;
  readonly name: string;
}

@Injectable()
export class AuthService {
  // Hash checked for unknown accounts so they take as long as real ones.
  private readonly dummyHash = hashPassword(randomUUID());

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    @Inject(TwoFactorService) private readonly twoFactor: TwoFactorService,
  ) {}

  /** Creates an organisation with the standard roles, its owner, and a session for the owner. */
  async signup(input: SignupInput): Promise<SessionGrant> {
    const passwordHash = await hashPassword(input.password);
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      return await this.connection.db.transaction(async (tx) => {
        await tx.insert(users).values({
          id: userId,
          fullName: input.fullName,
          phone: input.phone ?? null,
          email: input.email ?? null,
          passwordHash,
        });
        await setUpOrganization(tx, {
          organizationId,
          name: input.organizationName,
          ownerUserId: userId,
          plan: this.settings.signupPlan,
        });
        return this.issueSession(tx, userId, organizationId);
      });
    } catch (error) {
      if (isUniqueViolation(error, ['users_phone_unique', 'users_email_unique'])) {
        throw new ConflictException(
          'An account with this mobile number or email already exists. Sign in instead.',
        );
      }
      throw error;
    }
  }

  async loginWithPassword(input: PasswordLoginInput): Promise<SignInResult> {
    const user = await this.findUser(input.identifier);
    const matches = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await this.dummyHash),
    );
    if (!user?.passwordHash || !matches || !user.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return this.startSession(user.id, input.organizationId);
  }

  /**
   * Sends a one-time code by SMS. Answers the same whether or not the number
   * has an account; codes are only sent (and paid for) for registered numbers.
   */
  async requestOtp({ phone }: OtpRequestInput): Promise<void> {
    const { db } = this.connection;
    const recent = await db
      .select({ createdAt: otpChallenges.createdAt })
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phone, phone),
          gt(otpChallenges.createdAt, sql`now() - interval '1 hour'`),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt));
    const latest = recent[0]?.createdAt.getTime() ?? 0;
    if (Date.now() - latest < this.settings.otpResendCooldownMs) {
      throw new HttpException(
        'Please wait before requesting another code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (recent.length >= this.settings.otpMaxPerHour) {
      throw new HttpException(
        'Too many codes requested. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, phone), eq(users.isActive, true)));
    if (!user) return;

    const code = generateOtpCode();
    await this.sms.send(
      phone,
      `${code} is your sign-in code. It expires in 5 minutes. Never share it.`,
    );
    await db.insert(otpChallenges).values({
      phone,
      codeHash: hashOtpCode(this.settings.secret, phone, code),
      expiresAt: new Date(Date.now() + this.settings.otpTtlMs),
    });
  }

  async verifyOtp(input: OtpVerifyInput): Promise<SignInResult> {
    const { db } = this.connection;
    const [challenge] = await db
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phone, input.phone),
          isNull(otpChallenges.consumedAt),
          gt(otpChallenges.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    if (!challenge || challenge.attempts >= this.settings.otpMaxAttempts) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const expected = hashOtpCode(this.settings.secret, input.phone, input.code);
    if (!digestsEqual(expected, challenge.codeHash)) {
      await db
        .update(otpChallenges)
        .set({ attempts: sql`${otpChallenges.attempts} + 1` })
        .where(eq(otpChallenges.id, challenge.id));
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, input.phone), eq(users.isActive, true)));
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    // Choose the business before using up the code: someone in several
    // businesses is asked to choose (409) and sends the same code again with
    // the choice. Each such answer counts as an attempt, so a code can be
    // reused only a few times, and only until it expires.
    let organizationId: string;
    try {
      organizationId = await this.chooseOrganization(user.id, input.organizationId);
    } catch (error: unknown) {
      if (error instanceof ConflictException) {
        await db
          .update(otpChallenges)
          .set({ attempts: sql`${otpChallenges.attempts} + 1` })
          .where(eq(otpChallenges.id, challenge.id));
      }
      throw error;
    }

    // Consume atomically: of two simultaneous correct attempts, only one wins.
    const consumed = await db
      .update(otpChallenges)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    if (consumed.length === 0) throw new UnauthorizedException(INVALID_CREDENTIALS);

    return this.secondStep(user.id, organizationId);
  }

  /** Resolves a session token to the signed-in member, or null if it isn't valid now. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const { db } = this.connection;
    const [row] = await db
      .select({
        sessionId: sessions.id,
        userId: users.id,
        fullName: users.fullName,
        phone: users.phone,
        email: users.email,
        organizationId: organizations.id,
        organizationName: organizations.name,
        memberId: organizationMembers.id,
        allStores: organizationMembers.allStores,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        supportGrantId: sessions.supportGrantId,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, sessions.organizationId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, sessions.userId),
          eq(organizationMembers.organizationId, sessions.organizationId),
        ),
      )
      .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
      .leftJoin(supportGrants, eq(supportGrants.id, sessions.supportGrantId))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
          eq(users.isActive, true),
          eq(organizationMembers.isActive, true),
          or(
            isNull(sessions.supportGrantId),
            // Support sessions last only while their grant is approved and running.
            and(
              isNotNull(supportGrants.approvedAt),
              isNull(supportGrants.endedAt),
              gt(supportGrants.expiresAt, sql`now()`),
            ),
          ),
          // A suspended business is signed out at once; support can still look in.
          or(isNull(organizations.suspendedAt), isNotNull(sessions.supportGrantId)),
        ),
      );
    if (!row) return null;

    const permissionRows = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, row.roleId));
    const storeRows = row.allStores
      ? []
      : await db
          .select({ storeId: memberStores.storeId })
          .from(memberStores)
          .where(eq(memberStores.memberId, row.memberId));

    return {
      sessionId: row.sessionId,
      memberId: row.memberId,
      user: { id: row.userId, fullName: row.fullName, phone: row.phone, email: row.email },
      organization: { id: row.organizationId, name: row.organizationName },
      role: { key: row.roleKey, name: row.roleName },
      permissions: new Set(permissionRows.map((r) => r.permission).filter(isPermission)),
      allStores: row.allStores,
      storeIds: new Set(storeRows.map((r) => r.storeId)),
      ...(row.supportGrantId ? { supportGrantId: row.supportGrantId } : {}),
    };
  }

  /** Records one request made with platform support access; platform scope. */
  async recordSupportAccess(
    organizationId: string,
    grantId: string,
    method: string,
    path: string,
  ): Promise<void> {
    await this.connection.db
      .insert(supportAccessLog)
      .values({ organizationId, grantId, method, path: path.slice(0, 500) });
  }

  /** Signs out this device: the token stops working immediately. */
  async logout(sessionId: string): Promise<void> {
    await this.connection.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.id, sessionId));
  }

  private async findUser(identifier: string) {
    const email = normalizeEmail(identifier);
    const phone = normalizePhone(identifier);
    const condition = email ? eq(users.email, email) : phone ? eq(users.phone, phone) : undefined;
    if (!condition) return undefined;
    const [user] = await this.connection.db.select().from(users).where(condition);
    return user;
  }

  /** Picks the organisation to sign in to, then issues a session for it. */
  private async startSession(userId: string, organizationId?: string): Promise<SignInResult> {
    return this.secondStep(userId, await this.chooseOrganization(userId, organizationId));
  }

  /**
   * After the password or SMS code: a session, or a two-factor challenge for
   * people with an authenticator app, and for owners and admins of businesses
   * that require one (who add an app first).
   */
  private async secondStep(userId: string, organizationId: string): Promise<SignInResult> {
    if ((await this.twoFactor.status(userId)).enabled) {
      return { twoFactor: await this.twoFactor.challenge(userId, organizationId, false) };
    }
    if (await this.twoFactorRequired(userId, organizationId)) {
      return { twoFactor: await this.twoFactor.challenge(userId, organizationId, true) };
    }
    return this.connection.db.transaction((tx) => this.issueSession(tx, userId, organizationId));
  }

  /** True when the business requires two-factor sign-in of this member's role. */
  async twoFactorRequired(userId: string, organizationId: string): Promise<boolean> {
    const row = only(
      await this.connection.db
        .select({ required: organizations.twoFactorRequired, roleKey: roles.key })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .innerJoin(roles, eq(roles.id, organizationMembers.roleId))
        .where(
          and(
            eq(organizationMembers.userId, userId),
            eq(organizationMembers.organizationId, organizationId),
          ),
        ),
      'Membership',
    );
    return row.required && TWO_FACTOR_ROLES.includes(row.roleKey);
  }

  /** Adds an authenticator app during a sign-in that requires one. */
  async setUpTwoFactor(pendingToken: string): Promise<Enrolment> {
    const { userId } = await this.twoFactor.pending(pendingToken);
    return this.twoFactor.startEnrolment(
      userId,
      await this.twoFactor.accountLabel(userId),
      TOTP_ISSUER,
    );
  }

  /** The second step: a code from the app (or a recovery code) turns the challenge into a session. */
  async completeTwoFactor(pendingToken: string, code: string): Promise<TwoFactorSignIn> {
    const result = await this.twoFactor.completeChallenge(pendingToken, code, false);
    // Checked again: the member may have been removed, or the business suspended, meanwhile.
    const organizationId = await this.chooseOrganization(
      result.userId,
      String(result.organizationId),
    );
    const grant = await this.connection.db.transaction((tx) =>
      this.issueSession(tx, result.userId, organizationId),
    );
    return { ...grant, ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}) };
  }

  /**
   * The business to sign in to: the one asked for, or the only one. 409 with
   * the list when the person works for several and has not chosen; 401 when
   * they do not belong to it; 403 when it is suspended.
   */
  private async chooseOrganization(userId: string, organizationId?: string): Promise<string> {
    const memberships: (OrganizationChoice & { suspendedAt: Date | null })[] =
      await this.connection.db
        .select({
          id: organizations.id,
          name: organizations.name,
          suspendedAt: organizations.suspendedAt,
        })
        .from(organizationMembers)
        .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
        .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.isActive, true)))
        .orderBy(organizations.name);

    const chosen = organizationId
      ? memberships.find((membership) => membership.id === organizationId)
      : memberships.length === 1
        ? memberships[0]
        : undefined;

    if (!chosen && !organizationId && memberships.length > 1) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Choose which business to sign in to',
        organizations: memberships.map(({ id, name }) => ({ id, name })),
      });
    }
    if (!chosen) throw new UnauthorizedException(INVALID_CREDENTIALS);
    if (chosen.suspendedAt) {
      throw new ForbiddenException('This business is suspended. Please contact support.');
    }
    return chosen.id;
  }

  private async issueSession(
    tx: Transaction,
    userId: string,
    organizationId: string,
  ): Promise<SessionGrant> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + this.settings.sessionTtlMs);
    await tx.insert(sessions).values({
      tokenHash: hashSessionToken(token),
      userId,
      organizationId,
      expiresAt,
    });
    await tx
      .update(users)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(users.id, userId));
    return { token, expiresAt: expiresAt.toISOString(), organizationId };
  }
}
