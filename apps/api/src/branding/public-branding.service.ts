import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, type DatabaseConnection } from '@paint/db';
import {
  DEFAULT_BRANDING,
  normalizeSlug,
  validateBranding,
  type PublicBranding,
} from '@paint/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import {
  DOCUMENT_SERVICES,
  requireUploadServices,
  type DocumentServices,
} from '../documents/safe-upload.js';
import { LOGO_VERSION_LENGTH, logoUrl } from './logo-url.js';

const { organizationBranding, organizationLogos, organizations } = schema;

/** One answer for an unknown, suspended or logo-less business, so none can be told apart. */
const NOT_FOUND = 'Not found';

export interface PublicLogo {
  readonly storageKey: string;
  readonly contentType: string;
  readonly sha256: string;
}

/**
 * What a business's sign-in page shows before anyone signs in. Like sign-in
 * itself (auth.service.ts) this reads outside tenant scope, because no business
 * is known yet; it selects only the few public columns, by slug, and never for a
 * suspended business. Row-level security policies stay as they are.
 */
@Injectable()
export class PublicBrandingService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(DOCUMENT_SERVICES) private readonly services: DocumentServices | null,
  ) {}

  /** The app name, theme and logo address; 404 for unknown and suspended businesses alike. */
  async find(slug: string): Promise<PublicBranding> {
    const row = await this.lookup(slug);
    const branding = validateBranding(row.branding);
    return {
      slug: row.slug,
      // Stored only after validateBranding; no row means the default look.
      branding: branding.ok ? branding.branding : DEFAULT_BRANDING,
      logoUrl: row.sha256 === null ? null : logoUrl(row.slug, row.sha256),
    };
  }

  /** Where the logo is, when `version` names the current one; 404 otherwise. */
  async logo(slug: string, version: string): Promise<PublicLogo> {
    const row = await this.lookup(slug);
    // No logo, or not the current one.
    if (row.sha256?.slice(0, LOGO_VERSION_LENGTH) !== version) {
      throw new NotFoundException(NOT_FOUND);
    }
    return {
      storageKey: String(row.storageKey),
      contentType: String(row.contentType),
      sha256: row.sha256,
    };
  }

  /** The logo's bytes from storage (S3); never handed out as an S3 address. */
  logoBytes(logo: PublicLogo): Promise<Buffer> {
    return requireUploadServices(this.services).storage.get(logo.storageKey);
  }

  /** One query, the same for every slug, so timing says nothing about which exist. */
  private async lookup(slug: string) {
    const [row] = await this.connection.db
      .select({
        slug: organizations.slug,
        branding: organizationBranding.branding,
        sha256: organizationLogos.sha256,
        storageKey: organizationLogos.storageKey,
        contentType: organizationLogos.contentType,
      })
      .from(organizations)
      .leftJoin(organizationBranding, eq(organizationBranding.organizationId, organizations.id))
      .leftJoin(organizationLogos, eq(organizationLogos.organizationId, organizations.id))
      .where(
        and(
          eq(sql`lower(${organizations.slug})`, normalizeSlug(slug)),
          isNull(organizations.suspendedAt),
        ),
      );
    if (!row) throw new NotFoundException(NOT_FOUND);
    return row;
  }
}
