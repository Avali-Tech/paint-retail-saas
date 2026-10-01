import 'reflect-metadata';
import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { ReportsService, type ReportPage, type ReportSummary } from './reports.service.js';

// Each report checks its own permission (stock reports need inventory:read, and so on).
@Controller('reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext): ReportSummary[] {
    return this.reports.list(auth);
  }

  /** JSON by default (paged with limit and offset); format=csv downloads the whole report. */
  @Get(':kind')
  async run(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReportPage | string> {
    const { format, ...rest } = query;
    if (format !== 'csv') return this.reports.page(auth, kind, rest);
    const { filename, body } = await this.reports.csv(auth, kind, rest);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', attachmentHeader(filename));
    return body;
  }
}
