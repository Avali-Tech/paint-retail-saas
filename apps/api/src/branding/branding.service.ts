import 'reflect-metadata';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection } from '@paint/db';
import {
  deriveTheme,
  validateBranding,
  type Branding,
  type BrandingSaved,
  type BrandingView,
} from '@paint/shared';
import { eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';

const { organizationBranding } = schema;

/** A business's white-label look: app name, colours, mode, corners, density and font. */
@Injectable()
export class BrandingService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** The saved branding; 404 until the business sets it (the app then uses its own look). */
  get(auth: AuthContext): Promise<BrandingView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [row] = await tx
        .select({
          branding: organizationBranding.branding,
          updatedAt: organizationBranding.updatedAt,
        })
        .from(organizationBranding)
        .where(eq(organizationBranding.organizationId, auth.organization.id));
      if (!row) throw new NotFoundException('This business has not set its branding');
      // Stored only after validateBranding, so it is always a complete Branding.
      return {
        branding: row.branding as unknown as Branding,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Validates and normalises the branding with the same rules as the browser,
   * saves it, and reports how the theme adjusted colours that would be hard to read.
   */
  set(auth: AuthContext, input: unknown): Promise<BrandingSaved> {
    const result = validateBranding(input);
    if (!result.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Invalid branding',
        issues: result.issues,
      });
    }
    const { branding } = result;
    const stored = { ...branding };
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .insert(organizationBranding)
        .values({
          organizationId: auth.organization.id,
          branding: stored,
          updatedByMemberId: auth.memberId,
        })
        .onConflictDoUpdate({
          target: organizationBranding.organizationId,
          set: { branding: stored, updatedByMemberId: auth.memberId, updatedAt: sql`now()` },
        });
      return { branding, adjustments: deriveTheme(branding).adjustments };
    });
  }
}
