import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { validateSlug, type OrganizationIdentity } from '@paint/shared';
import { eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import {
  DOCUMENT_SERVICES,
  requireUploadServices,
  scanAndStore,
  type DocumentServices,
} from '../documents/safe-upload.js';
import { uploadRefusal } from '../documents/upload-refusals.js';
import { MAX_LOGO_SIDE, MIN_LOGO_SIDE, checkLogo } from './logo-checks.js';
import { logoUrl } from './logo-url.js';

const { organizationLogos, organizations } = schema;

/** What people are told when a logo is refused, by the refusal's code. */
export const LOGO_REFUSALS = {
  svg_not_allowed: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message:
      'SVG logos are not accepted because they can carry scripts. Save the logo as a PNG (with a transparent background), JPEG or WebP.',
  },
  file_type: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'Upload the logo as a PNG, JPEG or WebP picture',
  },
  dimensions: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: `Logos must be ${String(MIN_LOGO_SIDE)} to ${String(MAX_LOGO_SIDE)} pixels wide and high`,
  },
} as const;

/** The business's sign-in link name (slug) and logo. */
@Injectable()
export class IdentityService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(DOCUMENT_SERVICES) private readonly services: DocumentServices | null,
  ) {}

  /** For any member: the slug (for the sign-in link) and the logo, if any. */
  get(auth: AuthContext): Promise<OrganizationIdentity> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.read(tx, auth));
  }

  /** Changes the slug; 400 when it is not a valid name, 409 when another business has it. */
  async setSlug(auth: AuthContext, input: string): Promise<OrganizationIdentity> {
    const result = validateSlug(input);
    if (!result.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: result.message,
        code: result.problem,
        issues: [{ path: 'slug', message: result.message }],
      });
    }
    try {
      return await withTenant(this.connection.db, auth.organization.id, async (tx) => {
        await tx
          .update(organizations)
          .set({ slug: result.slug, updatedAt: sql`now()` })
          .where(eq(organizations.id, auth.organization.id));
        return this.read(tx, auth);
      });
    } catch (error) {
      if (isUniqueViolation(error, ['organizations_slug_unique'])) {
        const message = 'Another business uses this sign-in link. Choose another.';
        throw new ConflictException({
          statusCode: 409,
          message,
          code: 'taken',
          issues: [{ path: 'slug', message }],
        });
      }
      throw error;
    }
  }

  /**
   * Checks a logo from its bytes (PNG, JPEG or WebP; never SVG), scans it like a
   * document, stores it and makes it the business's logo. The old file is kept.
   */
  async uploadLogo(auth: AuthContext, data: Buffer): Promise<OrganizationIdentity> {
    const services = requireUploadServices(this.services);
    if (data.length === 0) {
      throw new BadRequestException(
        uploadRefusal(HttpStatus.BAD_REQUEST, 'empty_file', 'The file is empty'),
      );
    }
    const checked = checkLogo(data);
    if (!checked.ok) {
      const { status, message } = LOGO_REFUSALS[checked.code];
      const body = uploadRefusal(status, checked.code, message);
      throw status === HttpStatus.UNSUPPORTED_MEDIA_TYPE
        ? new UnsupportedMediaTypeException(body)
        : new UnprocessableEntityException(body);
    }
    const { logo } = checked;
    const storageKey = `${auth.organization.id}/branding/logo-${randomUUID()}`;
    await scanAndStore(services, { key: storageKey, data, contentType: logo.contentType });
    const row = {
      storageKey,
      contentType: logo.contentType,
      sizeBytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      width: logo.width,
      height: logo.height,
      uploadedByMemberId: auth.memberId,
    };
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .insert(organizationLogos)
        .values({ organizationId: auth.organization.id, ...row })
        .onConflictDoUpdate({
          target: organizationLogos.organizationId,
          set: { ...row, updatedAt: sql`now()` },
        });
      return this.read(tx, auth);
    });
  }

  /** Back to no logo (the app shows the first letter of its name); audited. */
  removeLogo(auth: AuthContext): Promise<OrganizationIdentity> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await tx
        .delete(organizationLogos)
        .where(eq(organizationLogos.organizationId, auth.organization.id));
      return this.read(tx, auth);
    });
  }

  private async read(tx: Transaction, auth: AuthContext): Promise<OrganizationIdentity> {
    const [row] = await tx
      .select({ slug: organizations.slug, logo: organizationLogos })
      .from(organizations)
      .leftJoin(organizationLogos, eq(organizationLogos.organizationId, organizations.id))
      .where(eq(organizations.id, auth.organization.id));
    // The signed-in member's own business always exists.
    const slug = String(row?.slug);
    const logo = row?.logo ?? null;
    return {
      slug,
      logo: logo && {
        url: logoUrl(slug, logo.sha256),
        contentType: logo.contentType,
        width: logo.width,
        height: logo.height,
        sizeBytes: logo.sizeBytes,
        updatedAt: logo.updatedAt.toISOString(),
      },
    };
  }
}
