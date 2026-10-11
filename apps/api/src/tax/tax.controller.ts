import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { GstRegistrations, TaxCategoryOptions, TaxCategoryView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GstRegistrationsService } from './gst-registrations.service.js';
import {
  addTaxRateSchema,
  businessGstSchema,
  createTaxCategorySchema,
  storeGstSchema,
  updateTaxCategorySchema,
  type AddTaxRateInput,
  type BusinessGstInput,
  type CreateTaxCategoryInput,
  type StoreGstInput,
  type UpdateTaxCategoryInput,
} from './tax.schemas.js';
import { TaxService } from './tax.service.js';

/** Settings, Tax & GST: tax categories with their rates, and GST registrations. */
@Controller()
export class TaxController {
  constructor(
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(GstRegistrationsService) private readonly registrations: GstRegistrationsService,
  ) {}

  @Get('tax-categories')
  @RequirePermissions('tax:read')
  list(@CurrentAuth() auth: AuthContext): Promise<TaxCategoryView[]> {
    return this.tax.list(auth);
  }

  /** Active categories with today's rate, for whoever edits products. */
  @Get('tax-categories/options')
  @RequirePermissions('catalog:read')
  options(@CurrentAuth() auth: AuthContext): Promise<TaxCategoryOptions> {
    return this.tax.options(auth);
  }

  @Post('tax-categories')
  @RequirePermissions('tax:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createTaxCategorySchema)) body: CreateTaxCategoryInput,
  ): Promise<TaxCategoryView> {
    return this.tax.create(auth, body);
  }

  @Patch('tax-categories/:id')
  @RequirePermissions('tax:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateTaxCategorySchema)) body: UpdateTaxCategoryInput,
  ): Promise<TaxCategoryView> {
    return this.tax.update(auth, id, body);
  }

  @Post('tax-categories/:id/rates')
  @RequirePermissions('tax:manage')
  addRate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addTaxRateSchema)) body: AddTaxRateInput,
  ): Promise<TaxCategoryView> {
    return this.tax.addRate(auth, id, body);
  }

  @Get('gst-registrations')
  @RequirePermissions('tax:read')
  registrationsView(@CurrentAuth() auth: AuthContext): Promise<GstRegistrations> {
    return this.registrations.get(auth);
  }

  @Put('gst-registrations/business')
  @RequirePermissions('tax:manage')
  setBusiness(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(businessGstSchema)) body: BusinessGstInput,
  ): Promise<GstRegistrations> {
    return this.registrations.setBusiness(auth, body);
  }

  @Put('gst-registrations/stores/:storeId')
  @RequirePermissions('tax:manage')
  setStore(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Body(new ZodValidationPipe(storeGstSchema)) body: StoreGstInput,
  ): Promise<GstRegistrations> {
    return this.registrations.setStore(auth, storeId, body);
  }
}
