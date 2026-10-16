import 'reflect-metadata';
import { Body, Controller, Get, Inject, Put, Query, Res } from '@nestjs/common';
import { withTenant, type DatabaseConnection } from '@paint/db';
import {
  BRAND_PROFITABILITY_PERMISSION,
  PROFITABILITY_SETTINGS_PERMISSION,
  type BrandProfitabilityView,
  type ProfitabilitySettings,
  type ProfitabilitySettingsInput,
} from '@paint/shared';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../database/database.module.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { ReportsService } from '../reports/reports.service.js';
import { brandProfitability } from './brand-profitability.js';
import {
  brandProfitabilitySchema,
  profitabilitySettingsSchema,
} from './brand-profitability.schemas.js';
import { saveProfitabilitySettings } from './profitability-settings.js';
import { schemeMoney } from './scheme-money.js';

/**
 * Brand profitability (roadmap P2-M35): which brand, product and store made the
 * business money over a period. JSON for the screen; format=csv downloads the
 * report through the reports framework (the `brand-profitability` report kind).
 */
@Controller('reports/brand-profitability')
export class BrandProfitabilityController {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  @Get()
  @RequirePermissions(BRAND_PROFITABILITY_PERMISSION)
  async view(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BrandProfitabilityView | string> {
    const { format, ...rest } = query;
    if (format === 'csv') {
      const { filename, body } = await this.reports.csv(auth, 'brand-profitability', rest);
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', attachmentHeader(filename));
      return body;
    }
    const filters = new ZodValidationPipe(brandProfitabilitySchema).transform(rest);
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      brandProfitability(tx, auth, filters, schemeMoney),
    );
  }

  /** The business's cost of money and point value, the report's defaults (owners and admins). */
  @Put('settings')
  @RequirePermissions(PROFITABILITY_SETTINGS_PERMISSION)
  settings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(profitabilitySettingsSchema)) body: ProfitabilitySettingsInput,
  ): Promise<ProfitabilitySettings> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      saveProfitabilitySettings(tx, auth.organization.id, body),
    );
  }
}
