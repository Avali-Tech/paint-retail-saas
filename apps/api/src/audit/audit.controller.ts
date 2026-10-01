import 'reflect-metadata';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { listAuditSchema, type ListAuditQuery } from './audit.schemas.js';
import { AuditService, type AuditPage } from './audit.service.js';

@Controller('audit-log')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** Newest first. Read-only: entries are written by the database itself. */
  @Get()
  @RequirePermissions('audit:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listAuditSchema)) query: ListAuditQuery,
  ): Promise<AuditPage> {
    return this.audit.list(auth, query);
  }
}
