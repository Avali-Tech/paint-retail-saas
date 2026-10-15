import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  STATEMENT_PERMISSION,
  buildStatementView,
  statementFileName,
  type StatementData,
  type StatementLinkView,
  type StatementShareResult,
} from '@paint/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { RateLimiter, clientAddress } from '../common/rate-limit.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { renderStatementPdf } from '../print/render-statement-pdf.js';
import { StatementLinksService } from './statement-links.service.js';
import {
  shareStatementSchema,
  statementPdfQuerySchema,
  statementQuerySchema,
  type ShareStatementInput,
  type StatementPdfQueryInput,
  type StatementQueryInput,
} from './statements.schemas.js';
import { StatementsService } from './statements.service.js';

const id = () => new ParseUUIDPipe();

/**
 * A party's statement of account (roadmap P2-M12): the data for the screen and its
 * A4 print, the same as a PDF to download, and stored links to share it (round 2a).
 */
@Controller('parties')
export class StatementsController {
  constructor(
    @Inject(StatementsService) private readonly statements: StatementsService,
    @Inject(StatementLinksService) private readonly links: StatementLinksService,
  ) {}

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

  @Post(':id/statement/links')
  @RequirePermissions(STATEMENT_PERMISSION)
  share(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(shareStatementSchema)) body: ShareStatementInput,
  ): Promise<StatementShareResult> {
    return this.links.share(auth, partyId, body);
  }

  @Get(':id/statement/links')
  @RequirePermissions(STATEMENT_PERMISSION)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
  ): Promise<StatementLinkView[]> {
    return this.links.links(auth, partyId);
  }
}

@Controller('statement-links')
export class StatementLinksController {
  constructor(@Inject(StatementLinksService) private readonly links: StatementLinksService) {}

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermissions(STATEMENT_PERMISSION)
  revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) linkId: string,
  ): Promise<StatementLinkView> {
    return this.links.revoke(auth, linkId);
  }
}

/** Opens a shared statement per client address per minute, at most. */
export const PUBLIC_STATEMENT_RATE = { limit: 30, windowMs: 60_000 } as const;

/**
 * A shared statement, without signing in (spec §6.4): the PDF behind a stored link,
 * rendered from the ledger of the day it is opened. Rate-limited per client address;
 * never cached, never indexed, and it names nothing about the business or party in
 * its errors.
 */
@Public()
@Controller('public/statements')
export class PublicStatementsController {
  private readonly limiter = new RateLimiter(
    PUBLIC_STATEMENT_RATE.limit,
    PUBLIC_STATEMENT_RATE.windowMs,
  );

  constructor(@Inject(StatementLinksService) private readonly links: StatementLinksService) {}

  @Get(':token')
  async open(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    if (!this.limiter.take(clientAddress(request.ip, request.headers['x-forwarded-for']))) {
      throw new HttpException(
        'Too many requests: try again in a minute',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const data = await this.links.publicStatement(token);
    void reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        attachmentHeader(statementFileName(data)).replace(/^attachment/, 'inline'),
      )
      .header('cache-control', 'private, no-store')
      .header('x-robots-tag', 'noindex, nofollow')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff');
    return renderStatementPdf(
      buildStatementView(data, data.language === 'en' ? null : data.language),
    );
  }
}
