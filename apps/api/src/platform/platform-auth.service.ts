import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { schema, type DatabaseConnection } from '@paint/db';
import { normalizeEmail, normalizePhone } from '@paint/shared';
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  digestsEqual,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../auth/credentials.js';
import { DATABASE } from '../database/database.module.js';
import type { BootstrapInput, PlatformLoginInput } from './platform.schemas.js';

const { platformAdmins, platformSessions, users } = schema;

export const PLATFORM_SETTINGS = Symbol('PLATFORM_SETTINGS');
export interface PlatformSettings {
  readonly bootstrapToken: string | null;
}

/** A signed-in platform operator. */
export interface Operator {
  readonly sessionId: string;
  readonly userId: string;
  readonly fullName: string;
}

export interface PlatformSession {
  readonly token: string;
  readonly expiresAt: string;
}

const SESSION_HOURS = 12;
const INVALID = 'Wrong email, mobile number or password';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Sign-in for the platform console, separate from businesses' sign-in. */
@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(PLATFORM_SETTINGS) private readonly settings: PlatformSettings,
  ) {}

  /** Creates the first operator, once, with the bootstrap token from the server's settings. */
  async bootstrap(input: BootstrapInput): Promise<PlatformSession> {
    const expected = this.settings.bootstrapToken;
    if (!expected) throw new NotFoundException('Bootstrap is turned off');
    if (!digestsEqual(sha256(input.token), sha256(expected))) {
      throw new ForbiddenException('Wrong bootstrap token');
    }
    const passwordHash = await hashPassword(input.password);
    return this.connection.db.transaction(async (tx) => {
      // Locks out a second bootstrap running at the same moment.
      await tx.execute(sql`lock table ${platformAdmins} in exclusive mode`);
      const [existing] = await tx.select({ n: count() }).from(platformAdmins);
      if (Number(existing?.n) > 0) {
        throw new ConflictException('The platform already has operators; sign in instead');
      }
      const [user] = await tx
        .insert(users)
        .values({
          fullName: input.fullName,
          email: input.email,
          phone: input.phone,
          passwordHash,
        })
        .returning({ id: users.id });
      const userId = String(user?.id);
      await tx.insert(platformAdmins).values({ userId });
      return this.issue(tx, userId);
    });
  }

  async login(input: PlatformLoginInput): Promise<PlatformSession> {
    const email = normalizeEmail(input.identifier);
    const phone = normalizePhone(input.identifier);
    const [user] = await this.connection.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .innerJoin(platformAdmins, eq(platformAdmins.userId, users.id))
      .where(
        and(
          eq(users.isActive, true),
          or(
            email ? eq(users.email, email) : undefined,
            phone ? eq(users.phone, phone) : undefined,
          ),
        ),
      );
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new UnauthorizedException(INVALID);
    }
    const userId = user.id;
    return this.connection.db.transaction((tx) => this.issue(tx, userId));
  }

  async authenticate(token: string): Promise<Operator | null> {
    const [row] = await this.connection.db
      .select({ sessionId: platformSessions.id, userId: users.id, fullName: users.fullName })
      .from(platformSessions)
      .innerJoin(users, eq(users.id, platformSessions.userId))
      .innerJoin(platformAdmins, eq(platformAdmins.userId, users.id))
      .where(
        and(
          eq(platformSessions.tokenHash, hashSessionToken(token)),
          isNull(platformSessions.revokedAt),
          gt(platformSessions.expiresAt, sql`now()`),
          eq(users.isActive, true),
        ),
      );
    return row ?? null;
  }

  async logout(sessionId: string): Promise<void> {
    await this.connection.db
      .update(platformSessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(platformSessions.id, sessionId));
  }

  private async issue(
    tx: Parameters<Parameters<DatabaseConnection['db']['transaction']>[0]>[0],
    userId: string,
  ): Promise<PlatformSession> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    await tx
      .insert(platformSessions)
      .values({ tokenHash: hashSessionToken(token), userId, expiresAt });
    return { token, expiresAt: expiresAt.toISOString() };
  }
}
