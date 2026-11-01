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
import {
  printViewOf,
  type IssuedInvoiceView,
  type PrintableInvoiceView,
  type SaleCreditView,
  type TaxDocumentPage,
  type TaxDocumentView,
} from '@paint/shared';
import type { FastifyReply } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { renderInvoicePdf } from '../print/render-invoice-pdf.js';
import {
  cancelInvoiceSchema,
  draftInvoiceSchema,
  idempotencyKeySchema,
  invoiceCreditCheckSchema,
  invoicePdfQuerySchema,
  issueInvoiceSchema,
  listInvoicesSchema,
  type CancelInvoiceInput,
  type DraftInvoiceInput,
  type InvoicePdfQuery,
  type IssueInvoiceInput,
  type ListInvoicesQuery,
} from './billing.schemas.js';
import { IdempotencyKey } from './idempotency.js';
import { InvoiceIssueService } from './invoice-issue.service.js';
import { InvoicesService } from './invoices.service.js';

const id = () => new ParseUUIDPipe();

/** Tax invoices and bills of supply: drafts (held bills), issue (with payments) and same-day cancel. */
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

  /** Where the customer stands for issuing this draft with `unpaidPaise` left on credit (MVP 3 §4.2). */
  @Get(':id/credit-check')
  @RequirePermissions('billing:issue')
  creditCheck(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) documentId: string,
    @Query(new ZodValidationPipe(invoiceCreditCheckSchema)) query: { unpaidPaise: number },
  ): Promise<SaleCreditView> {
    return this.issuing.creditCheck(auth, documentId, query.unpaidPaise);
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

  /** An issued invoice with its print settings, to reprint it on A4 or the counter printer. */
  @Get(':id/print')
  @RequirePermissions('sales:read')
  print(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
  ): Promise<PrintableInvoiceView> {
    return this.invoices.printable(auth, invoiceId);
  }

  /** The issued invoice as an A4 PDF, drawn from the same print view (no logo yet: PO-151). */
  @Get(':id/invoice.pdf')
  @RequirePermissions('sales:read')
  async pdf(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Query(new ZodValidationPipe(invoicePdfQuerySchema)) query: InvoicePdfQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const invoice = await this.invoices.printable(auth, invoiceId);
    const view = printViewOf(invoice, query.lang === 'en' ? null : query.lang, null);
    void reply
      .header('content-type', 'application/pdf')
      .header(
        'content-disposition',
        attachmentHeader(`${String(invoice.number).replaceAll('/', '-')}.pdf`),
      )
      .header('cache-control', 'private, no-store');
    return renderInvoicePdf(view);
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
  ): Promise<IssuedInvoiceView> {
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
