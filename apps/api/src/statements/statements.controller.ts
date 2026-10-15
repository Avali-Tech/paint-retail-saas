import 'reflect-metadata';
import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import {
  STATEMENT_PERMISSION,
  buildStatementView,
  statementFileName,
  type StatementData,
} from '@paint/shared';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { renderStatementPdf } from '../print/render-statement-pdf.js';
import {
  statementPdfQuerySchema,
  statementQuerySchema,
  type StatementPdfQueryInput,
  type StatementQueryInput,
} from './statements.schemas.js';
import { StatementsService } from './statements.service.js';

const id = () => new ParseUUIDPipe();

/**
 * A party's statement of account (roadmap P2-M12): the data for the screen and its
 * A4 print, and the same as a PDF to download and share. Members only: a signed,
 * expiring public link needs a token table, so it waits for a later round.
 */
@Controller('parties')
export class StatementsController {
  constructor(@Inject(StatementsService) private readonly statements: StatementsService) {}

  @Get(':id/statement')
  @RequirePermissions(STATEMENT_PERMISSION)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(statementQuerySchema)) query: StatementQueryInput,
  ): Promise<StatementData> {
    return this.statements.statement(auth, partyId, query);
  }

  @Get(':id/statement.pdf')
  @RequirePermissions(STATEMENT_PERMISSION)
  async pdf(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(statementPdfQuerySchema)) query: StatementPdfQueryInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { lang, ...period } = query;
    const data = await this.statements.statement(auth, partyId, period);
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', attachmentHeader(statementFileName(data)))
      .header('cache-control', 'private, no-store');
    return renderStatementPdf(buildStatementView(data, lang === 'en' ? null : lang));
  }
}
