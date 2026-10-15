import 'reflect-metadata';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import {
  RECEIVABLES_PERMISSION,
  type AgeingPage,
  type ReceivablesSummaryView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  ageingQuerySchema,
  receivablesQuerySchema,
  type AgeingQueryInput,
  type ReceivablesQueryInput,
} from './receivables.schemas.js';
import { ReceivablesService } from './receivables.service.js';

/**
 * What customers owe (roadmap P2-M10): the receivables dashboard and the ageing
 * tables, as of any day. The CSV exports are reports (GET /reports/receivables-ageing).
 */
@Controller('receivables')
export class ReceivablesController {
  constructor(@Inject(ReceivablesService) private readonly receivables: ReceivablesService) {}

  @Get('summary')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  summary(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(receivablesQuerySchema)) query: ReceivablesQueryInput,
  ): Promise<ReceivablesSummaryView> {
    return this.receivables.summary(auth, query);
  }

  @Get('ageing')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  ageing(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ageingQuerySchema)) query: AgeingQueryInput,
  ): Promise<AgeingPage> {
    return this.receivables.ageing(auth, query);
  }
}
