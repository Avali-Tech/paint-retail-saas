import 'reflect-metadata';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { ImportReport } from './import-types.js';
import { ImportsService, type ImportKind } from './imports.service.js';

const fileSchema = z.object({ csv: z.string().min(1).max(3_500_000) });

// Each import checks the permission for its kind (products → catalog:manage, and so on).
@Controller('imports')
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Get()
  kinds(): ImportKind[] {
    return this.imports.kinds();
  }

  @Get(':kind/template')
  template(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): string {
    const csv = this.imports.template(auth, kind);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${kind}-template.csv"`);
    return csv;
  }

  @Post(':kind/preview')
  @HttpCode(200)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(fileSchema)) body: { csv: string },
  ): Promise<ImportReport> {
    return this.imports.preview(auth, kind, body.csv);
  }

  @Post(':kind')
  commit(
    @CurrentAuth() auth: AuthContext,
    @Param('kind') kind: string,
    @Body(new ZodValidationPipe(fileSchema)) body: { csv: string },
  ): Promise<ImportReport> {
    return this.imports.commit(auth, kind, body.csv);
  }
}
