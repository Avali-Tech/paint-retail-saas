import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { enterTenantScope, schema, withTenant, type DatabaseConnection } from '@paint/db';
import type { TwoFactorSignIn } from '@paint/shared';
import { and, eq, sql } from 'drizzle-orm';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../database/database.module.js';
import type { AuthContext } from './auth-context.js';
import { AuthService, TOTP_ISSUER } from './auth.service.js';
import { CurrentAuth, Public, RequirePermissions } from './decorators.js';
import {
  codeSchema,
  pendingCodeSchema,
  pendingSchema,
  securitySchema,
} from './two-factor.schemas.js';
import { TwoFactorService, type Enrolment } from './two-factor.service.js';

const { organizationMembers, organizations, sessions } = schema;

/** Support sessions never change anyone's sign-in. */
function notSupport(auth: AuthContext): void {
  if (auth.supportGrantId) {
    throw new ForbiddenException('Support access cannot change two-factor sign-in');
  }
}

/** Two-factor sign-in (TOTP): the sign-in step, the member's own settings, owners' controls. */
@Controller()
export class TwoFactorController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TwoFactorService) private readonly twoFactor: TwoFactorService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
  ) {}

  /** During a sign-in that requires it: adds an authenticator app (scan the URI as a QR code). */
  @Public()
  @Post('auth/2fa/setup')
  @HttpCode(200)
  setUp(
    @Body(new ZodValidationPipe(pendingSchema)) body: { pendingToken: string },
  ): Promise<Enrolment> {
    return this.auth.setUpTwoFactor(body.pendingToken);
  }

  /** The second step: a code from the app or a recovery code; 5 tries, 5 minutes. */
  @Public()
  @Post('auth/2fa/verify')
  @HttpCode(200)
  verify(
    @Body(new ZodValidationPipe(pendingCodeSchema)) body: { pendingToken: string; code: string },
  ): Promise<TwoFactorSignIn> {
    return this.auth.completeTwoFactor(body.pendingToken, body.code);
  }

  /** The member's own two-factor sign-in, and whether their business requires it of them. */
  @Get('auth/2fa')
  async status(
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ enabled: boolean; recoveryCodesLeft: number; required: boolean }> {
    return {
      ...(await this.twoFactor.status(auth.user.id)),
      required: await this.auth.twoFactorRequired(auth.user.id, auth.organization.id),
    };
  }

  @Post('auth/2fa/enrol')
  @HttpCode(200)
  async enrol(@CurrentAuth() auth: AuthContext): Promise<Enrolment> {
    notSupport(auth);
    return this.twoFactor.startEnrolment(
      auth.user.id,
      await this.twoFactor.accountLabel(auth.user.id),
      TOTP_ISSUER,
    );
  }

  /** Confirms the app with its first code; answers the recovery codes, shown once. */
  @Post('auth/2fa/confirm')
  @HttpCode(200)
  async confirm(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ): Promise<{ recoveryCodes: string[] }> {
    notSupport(auth);
    return { recoveryCodes: await this.twoFactor.confirmEnrolment(auth.user.id, body.code) };
  }

  @Post('auth/2fa/recovery-codes')
  @HttpCode(200)
  async recoveryCodes(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ): Promise<{ recoveryCodes: string[] }> {
    notSupport(auth);
    return {
      recoveryCodes: await this.twoFactor.regenerateRecoveryCodes(auth.user.id, body.code),
    };
  }

  /** Turns it off, unless the business requires it of the member's role. */
  @Post('auth/2fa/disable')
  @HttpCode(204)
  async disable(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
  ): Promise<void> {
    notSupport(auth);
    if (await this.auth.twoFactorRequired(auth.user.id, auth.organization.id)) {
      throw new ForbiddenException('Your business requires two-factor sign-in for your role');
    }
    await this.twoFactor.disable(auth.user.id, body.code);
  }

  /**
   * An owner resets a member's two-factor sign-in (e.g. a lost phone): the app
   * and recovery codes are removed and the member is signed out here. Audited.
   */
  @Post('members/:id/two-factor/reset')
  @HttpCode(204)
  @RequirePermissions('organization:manage')
  async reset(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) memberId: string,
  ): Promise<void> {
    // Support sessions never get here: their role lacks organization:manage.
    if (auth.role.key !== 'owner') {
      throw new ForbiddenException('Only an owner can reset two-factor sign-in');
    }
    if (memberId === auth.memberId) {
      throw new BadRequestException('Ask another owner to reset your own two-factor sign-in');
    }
    await this.connection.db.transaction(async (tx) => {
      // Platform scope first (secrets and sessions), then the audited tenant change.
      const [member] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.id, memberId),
            eq(organizationMembers.organizationId, auth.organization.id),
            eq(organizationMembers.isSupport, false),
          ),
        );
      if (!member) throw new NotFoundException('Member not found');
      await this.twoFactor.remove(tx, member.userId);
      await tx
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(sessions.userId, member.userId),
            eq(sessions.organizationId, auth.organization.id),
          ),
        );
      await enterTenantScope(tx, auth.organization.id);
      await tx
        .update(organizationMembers)
        .set({ twoFactorResetAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(organizationMembers.id, memberId));
    });
  }

  @Get('organization/security')
  @RequirePermissions('organization:manage')
  security(@CurrentAuth() auth: AuthContext): Promise<{ twoFactorRequired: boolean }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [row] = await tx
        .select({ twoFactorRequired: organizations.twoFactorRequired })
        .from(organizations)
        .where(eq(organizations.id, auth.organization.id));
      return { twoFactorRequired: Boolean(row?.twoFactorRequired) };
    });
  }

  /** Whether owners and organization admins must use two-factor sign-in. Audited. */
  @Put('organization/security')
  @RequirePermissions('organization:manage')
  setSecurity(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(securitySchema)) body: { twoFactorRequired: boolean },
  ): Promise<{ twoFactorRequired: boolean }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .update(organizations)
        .set({ twoFactorRequired: body.twoFactorRequired, updatedAt: sql`now()` })
        .where(eq(organizations.id, auth.organization.id));
      return { twoFactorRequired: body.twoFactorRequired };
    });
  }
}
