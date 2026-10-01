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
import { isPermission, normalizeEmail, normalizePhone } from '@paint/shared';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
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

const {
  memberStores,
  organizationMembers,
  organizations,
  otpChallenges,
  rolePermissions,
  roles,
  sessions,
  users,
} = schema;

/** Same message for every sign-in failure, so responses never reveal who has an account. */
const INVALID_CREDENTIALS = 'Invalid sign-in details';

export interface SessionGrant {
  /** Give to the client once; send back as "Authorization: Bearer <token>". */
  readonly token: string;
  readonly expiresAt: string;
  readonly organizationId: string;
}

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

  async loginWithPassword(input: PasswordLoginInput): Promise<SessionGrant> {
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

  async verifyOtp(input: OtpVerifyInput): Promise<SessionGrant> {
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

    // Consume atomically: of two simultaneous correct attempts, only one wins.
    const consumed = await db
      .update(otpChallenges)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.phone, input.phone), eq(users.isActive, true)));
    if (consumed.length === 0 || !user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    return this.startSession(user.id, input.organizationId);
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
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, sql`now()`),
          eq(users.isActive, true),
          eq(organizationMembers.isActive, true),
          // A suspended business is signed out at once.
          isNull(organizations.suspendedAt),
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
    };
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
  private async startSession(userId: string, organizationId?: string): Promise<SessionGrant> {
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

    return this.connection.db.transaction((tx) => this.issueSession(tx, userId, chosen.id));
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
