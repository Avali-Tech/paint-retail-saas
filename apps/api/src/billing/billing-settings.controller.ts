import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { DocumentSeriesView, GstinProfileView, SalesSettingsView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createSeriesSchema,
  gstinParamSchema,
  gstinProfileSchema,
  listSeriesSchema,
  salesSettingsSchema,
  updateSeriesSchema,
  type CreateSeriesInput,
  type GstinProfileInput,
  type ListSeriesQuery,
  type SalesSettingsInput,
  type UpdateSeriesInput,
} from './billing.schemas.js';
import { BillingSettingsService } from './billing-settings.service.js';

/** Sales settings, document series and GSTIN profiles. */
@Controller()
export class BillingSettingsController {
  constructor(@Inject(BillingSettingsService) private readonly settings: BillingSettingsService) {}

  @Get('sales/settings')
  @RequirePermissions('organization:manage')
  get(@CurrentAuth() auth: AuthContext): Promise<SalesSettingsView> {
    return this.settings.settings(auth);
  }

  @Put('sales/settings')
  @RequirePermissions('organization:manage')
  put(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(salesSettingsSchema)) body: SalesSettingsInput,
  ): Promise<SalesSettingsView> {
    return this.settings.updateSettings(auth, body);
  }

  @Get('document-series')
  @RequirePermissions('billing:issue')
  listSeries(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listSeriesSchema)) query: ListSeriesQuery,
  ): Promise<DocumentSeriesView[]> {
    return this.settings.listSeries(auth, query);
  }

  @Post('document-series')
  @RequirePermissions('billing:issue')
  createSeries(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createSeriesSchema)) body: CreateSeriesInput,
  ): Promise<DocumentSeriesView> {
    return this.settings.createSeries(auth, body);
  }

  @Put('document-series/:id')
  @RequirePermissions('billing:issue')
  updateSeries(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateSeriesSchema)) body: UpdateSeriesInput,
  ): Promise<DocumentSeriesView> {
    return this.settings.updateSeries(auth, id, body);
  }

  @Get('gstin-profiles')
  @RequirePermissions('tax:read')
  profiles(@CurrentAuth() auth: AuthContext): Promise<GstinProfileView[]> {
    return this.settings.gstinProfiles(auth);
  }

  @Put('gstin-profiles/:gstin')
  @RequirePermissions('tax:manage')
  updateProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('gstin', new ZodValidationPipe(gstinParamSchema)) gstin: string,
    @Body(new ZodValidationPipe(gstinProfileSchema)) body: GstinProfileInput,
  ): Promise<GstinProfileView> {
    return this.settings.updateGstinProfile(auth, gstin, body);
  }
}
