import 'reflect-metadata';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { dashboardSchema } from './dashboard.schemas.js';
import { DashboardService, type Dashboard } from './dashboard.service.js';

@Controller('dashboard')
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboards: DashboardService) {}

  /** Every store the member works at (or one of them); each section checks its permission. */
  @Get()
  @RequirePermissions('stores:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(dashboardSchema)) query: { storeId?: string },
  ): Promise<Dashboard> {
    return this.dashboards.get(auth, query.storeId);
  }
}
