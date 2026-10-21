import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type {} from '@fastify/multipart';
import type {
  BrandStatementDetail,
  BrandStatementSummaryView,
  MatchRunResult,
  StatementPreview,
  StatementTemplateView,
} from '@paint/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader, MAX_DOCUMENT_BYTES } from '../documents/file-checks.js';
import { uploadRefusal } from '../documents/upload-refusals.js';
import {
  explainSchema,
  importFieldsSchema,
  listStatementsSchema,
  manualMatchSchema,
  schemeReceiptSchema,
  templateSchema,
  type ExplainBody,
  type ListStatementsQuery,
  type ManualMatchBody,
  type SchemeReceiptBody,
  type TemplateBody,
} from './brand-statements.schemas.js';
import { BrandStatementsService, type UploadedStatement } from './brand-statements.service.js';

const id = () => new ParseUUIDPipe();

/** The fields and the one file of a multipart upload. */
async function readUpload(
  request: FastifyRequest,
): Promise<{ fields: Record<string, string>; file: UploadedStatement }> {
  if (!request.isMultipart()) {
    throw new BadRequestException('Send the statement as multipart/form-data');
  }
  const fields: Record<string, string> = {};
  const files: (UploadedStatement & { truncated: boolean })[] = [];
  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
      } else {
        const data = await part.toBuffer();
        files.push({ fileName: part.filename, data, truncated: part.file.truncated });
      }
    }
  } catch (error) {
    throw new BadRequestException(`The upload could not be read: ${(error as Error).message}`);
  }
  const [file] = files;
  if (!file) throw new BadRequestException('Attach the statement file');
  if (file.truncated) {
    throw new PayloadTooLargeException(
      uploadRefusal(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'too_large',
        `Files can be at most ${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB`,
      ),
    );
  }
  return { fields, file: { fileName: file.fileName, data: file.data } };
}

/**
 * Brand statement reconciliation (P2-M34): anyone who may see purchasing sees statements
 * and how they reconcile; owners and admins (`schemes:manage`) make templates, import
 * statements and match their lines.
 */
@Controller('brand-statements')
export class BrandStatementsController {
  constructor(
    @Inject(BrandStatementsService) private readonly statements: BrandStatementsService,
  ) {}

  @Get('templates')
  @RequirePermissions('purchasing:read')
  templates(@CurrentAuth() auth: AuthContext): Promise<StatementTemplateView[]> {
    return this.statements.listTemplates(auth);
  }

  @Post('templates')
  @RequirePermissions('schemes:manage')
  createTemplate(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(templateSchema)) body: TemplateBody,
  ): Promise<StatementTemplateView> {
    return this.statements.createTemplate(auth, body);
  }

  @Put('templates/:id')
  @RequirePermissions('schemes:manage')
  updateTemplate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) templateId: string,
    @Body(new ZodValidationPipe(templateSchema)) body: TemplateBody,
  ): Promise<StatementTemplateView> {
    return this.statements.updateTemplate(auth, templateId, body);
  }

  /** multipart/form-data: templateId and the file. Stores nothing. */
  @Post('preview')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  async preview(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
  ): Promise<StatementPreview> {
    const { fields, file } = await readUpload(request);
    const { templateId } = new ZodValidationPipe(importFieldsSchema).transform({
      templateId: fields.templateId,
    });
    return this.statements.preview(auth, templateId, file);
  }

  /** multipart/form-data: templateId, the period and balances (optional) and the file. */
  @Post()
  @RequirePermissions('schemes:manage')
  async import(
    @CurrentAuth() auth: AuthContext,
    @Req() request: FastifyRequest,
  ): Promise<BrandStatementDetail> {
    const { fields, file } = await readUpload(request);
    return this.statements.import(
      auth,
      new ZodValidationPipe(importFieldsSchema).transform(fields),
      file,
    );
  }

  @Get()
  @RequirePermissions('purchasing:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listStatementsSchema)) query: ListStatementsQuery,
  ): Promise<BrandStatementSummaryView[]> {
    return this.statements.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('purchasing:read')
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
  ): Promise<BrandStatementDetail> {
    return this.statements.detail(auth, statementId);
  }

  @Get(':id/mismatches.csv')
  @RequirePermissions('purchasing:read', 'data:export')
  async exportCsv(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const { fileName, csv } = await this.statements.exportCsv(auth, statementId);
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', attachmentHeader(fileName));
    return csv;
  }

  @Get(':id/file')
  @RequirePermissions('purchasing:read')
  async file(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { fileName, contentType, data } = await this.statements.file(auth, statementId);
    void reply
      .header('content-type', contentType)
      .header('content-disposition', attachmentHeader(fileName))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return data;
  }

  @Post(':id/match')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  rematch(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
  ): Promise<MatchRunResult> {
    return this.statements.rematch(auth, statementId);
  }

  @Post(':id/discard')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  discard(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
  ): Promise<BrandStatementSummaryView> {
    return this.statements.discard(auth, statementId);
  }

  @Post(':id/lines/:lineId/match')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  match(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Param('lineId', id()) lineId: string,
    @Body(new ZodValidationPipe(manualMatchSchema)) body: ManualMatchBody,
  ): Promise<BrandStatementDetail> {
    return this.statements.match(auth, statementId, lineId, body);
  }

  @Delete(':id/lines/:lineId/match')
  @RequirePermissions('schemes:manage')
  unmatch(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Param('lineId', id()) lineId: string,
  ): Promise<BrandStatementDetail> {
    return this.statements.unmatch(auth, statementId, lineId);
  }

  @Post(':id/lines/:lineId/explain')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  explain(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Param('lineId', id()) lineId: string,
    @Body(new ZodValidationPipe(explainSchema)) body: ExplainBody,
  ): Promise<BrandStatementDetail> {
    return this.statements.explain(auth, statementId, lineId, body);
  }

  @Post(':id/lines/:lineId/scheme-receipt')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  schemeReceipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) statementId: string,
    @Param('lineId', id()) lineId: string,
    @Body(new ZodValidationPipe(schemeReceiptSchema)) body: SchemeReceiptBody,
  ): Promise<BrandStatementDetail> {
    return this.statements.schemeReceipt(auth, statementId, lineId, body);
  }
}
