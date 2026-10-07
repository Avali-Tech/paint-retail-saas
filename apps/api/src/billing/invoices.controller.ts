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
} from '@nestjs/common';
import type { TaxDocumentPage, TaxDocumentView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  cancelInvoiceSchema,
  draftInvoiceSchema,
  idempotencyKeySchema,
  issueInvoiceSchema,
  listInvoicesSchema,
  type CancelInvoiceInput,
  type DraftInvoiceInput,
  type IssueInvoiceInput,
  type ListInvoicesQuery,
} from './billing.schemas.js';
import { IdempotencyKey } from './idempotency.js';
import { InvoiceIssueService } from './invoice-issue.service.js';
import { InvoicesService } from './invoices.service.js';

const id = () => new ParseUUIDPipe();

/** Tax invoices and bills of supply: drafts (held bills), issue and same-day cancel. */
@Controller('invoices')
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(InvoiceIssueService) private readonly issuing: InvoiceIssueService,
  ) {}

  @Post()
  @RequirePermissions('billing:issue')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(draftInvoiceSchema)) body: DraftInvoiceInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string | undefined,
  ): Promise<TaxDocumentView> {
    return this.invoices.create(auth, body, key);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listInvoicesSchema)) query: ListInvoicesQuery,
  ): Promise<TaxDocumentPage> {
    return this.invoices.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
  ): Promise<TaxDocumentView> {
    return this.invoices.get(auth, invoiceId);
  }

  @Put(':id')
  @RequirePermissions('billing:issue')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Body(new ZodValidationPipe(draftInvoiceSchema)) body: DraftInvoiceInput,
  ): Promise<TaxDocumentView> {
    return this.invoices.update(auth, invoiceId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('billing:issue')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) invoiceId: string): Promise<void> {
    return this.invoices.remove(auth, invoiceId);
  }

  @Post(':id/issue')
  @HttpCode(200)
  @RequirePermissions('billing:issue')
  issue(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Body(new ZodValidationPipe(issueInvoiceSchema)) body: IssueInvoiceInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string | undefined,
  ): Promise<TaxDocumentView> {
    return this.issuing.issue(auth, invoiceId, body, key);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('billing:cancel')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Body(new ZodValidationPipe(cancelInvoiceSchema)) body: CancelInvoiceInput,
  ): Promise<TaxDocumentView> {
    return this.issuing.cancel(auth, invoiceId, body);
  }
}
