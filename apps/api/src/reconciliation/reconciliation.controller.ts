import 'reflect-metadata';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type {
  LatestReconciliation,
  ReconciliationRunPage,
  ReconciliationRunView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { listRunsSchema, type ListRunsQuery } from './reconciliation.schemas.js';
import { ReconciliationService } from './reconciliation.service.js';

/** The nightly reconciliation of the books (spec §3.3, §4.6), and running one now. */
@Controller('reconciliation')
export class ReconciliationController {
  constructor(@Inject(ReconciliationService) private readonly runs: ReconciliationService) {}

  @Get('latest')
  @RequirePermissions('accounting:reconcile')
  latest(@CurrentAuth() auth: AuthContext): Promise<LatestReconciliation> {
    return this.runs.latest(auth);
  }

  @Get('runs')
  @RequirePermissions('accounting:reconcile')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listRunsSchema)) query: ListRunsQuery,
  ): Promise<ReconciliationRunPage> {
    return this.runs.list(auth, query);
  }

  @Get('runs/:id')
  @RequirePermissions('accounting:reconcile')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReconciliationRunView> {
    return this.runs.get(auth, id);
  }

  @Post('runs')
  @RequirePermissions('accounting:reconcile')
  run(@CurrentAuth() auth: AuthContext): Promise<ReconciliationRunView> {
    return this.runs.run(auth);
  }
}
