import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type {
  AccountingExportPage,
  AccountingExportPreview,
  LedgerMappingView,
} from '@paint/shared';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { AccountingExportsService } from './accounting-exports.service.js';
import {
  createExportSchema,
  exportPreviewSchema,
  ledgerMappingSchema,
  listExportsSchema,
  type CreateExportInput,
  type ExportPreviewQuery,
  type LedgerMappingInput,
  type ListExportsQuery,
} from './accounting.schemas.js';
import { LedgerMappingsService } from './ledger-mappings.service.js';

const id = () => new ParseUUIDPipe();

/** Which Tally ledger each amount posts to (spec §6.1): the exporter maintains them. */
@Controller('ledger-mappings')
export class LedgerMappingsController {
  constructor(@Inject(LedgerMappingsService) private readonly mappings: LedgerMappingsService) {}

  @Get()
  @RequirePermissions('accounting:export')
  list(@CurrentAuth() auth: AuthContext): Promise<LedgerMappingView[]> {
    return this.mappings.list(auth);
  }

  @Post()
  @RequirePermissions('accounting:export')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(ledgerMappingSchema)) body: LedgerMappingInput,
  ): Promise<LedgerMappingView> {
    return this.mappings.create(auth, body);
  }

  @Put(':id')
  @RequirePermissions('accounting:export')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) mappingId: string,
    @Body(new ZodValidationPipe(ledgerMappingSchema)) body: LedgerMappingInput,
  ): Promise<LedgerMappingView> {
    return this.mappings.update(auth, mappingId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('accounting:export')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) mappingId: string): Promise<void> {
    return this.mappings.remove(auth, mappingId);
  }
}

/** A period's books for Tally (spec §6.1): preview, export (the file itself) and history. */
@Controller('accounting-exports')
export class AccountingExportsController {
  constructor(
    @Inject(AccountingExportsService) private readonly exports: AccountingExportsService,
  ) {}

  @Get()
  @RequirePermissions('accounting:export')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listExportsSchema)) query: ListExportsQuery,
  ): Promise<AccountingExportPage> {
    return this.exports.list(auth, query);
  }

  @Get('preview')
  @RequirePermissions('accounting:export')
  preview(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(exportPreviewSchema)) query: ExportPreviewQuery,
  ): Promise<AccountingExportPreview> {
    return this.exports.preview(auth, query);
  }

  /** Answers the file; the export's id is in X-Accounting-Export-Id. */
  @Post()
  @RequirePermissions('accounting:export')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createExportSchema)) body: CreateExportInput,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { view, file } = await this.exports.create(auth, body);
    void reply
      .header('content-type', file.contentType)
      .header('content-disposition', attachmentHeader(file.fileName))
      .header('x-accounting-export-id', view.id)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store');
    return Buffer.from(file.bytes);
  }
}
