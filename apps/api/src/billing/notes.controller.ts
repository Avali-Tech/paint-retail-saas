import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  NOTES_PERMISSION,
  type InvoiceAdjustments,
  type NotePage,
  type NoteView,
  type SalesReturnView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { idempotencyKeySchema } from './billing.schemas.js';
import { IdempotencyKey } from './idempotency.js';
import { NoteIssueService } from './note-issue.service.js';
import {
  creditNoteSchema,
  debitNoteSchema,
  listNotesSchema,
  salesReturnSchema,
  type CreditNoteInput,
  type DebitNoteInput,
  type ListNotesQuery,
  type SalesReturnInput,
} from './notes.schemas.js';
import { NotesService } from './notes.service.js';

const id = () => new ParseUUIDPipe();

/** Sales returns, credit notes and debit notes against issued invoices (round 3c). */
@Controller()
export class NotesController {
  constructor(
    @Inject(NoteIssueService) private readonly issuing: NoteIssueService,
    @Inject(NotesService) private readonly notes: NotesService,
  ) {}

  @Post('sales-returns')
  @RequirePermissions(NOTES_PERMISSION)
  returnGoods(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(salesReturnSchema)) body: SalesReturnInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string | undefined,
  ): Promise<SalesReturnView> {
    return this.issuing.returnGoods(auth, body, key);
  }

  @Get('sales-returns/:id')
  @RequirePermissions('sales:read')
  getReturn(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) returnId: string,
  ): Promise<SalesReturnView> {
    return this.notes.getReturn(auth, returnId);
  }

  @Post('credit-notes')
  @RequirePermissions(NOTES_PERMISSION)
  creditNote(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(creditNoteSchema)) body: CreditNoteInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string | undefined,
  ): Promise<NoteView> {
    return this.issuing.creditNote(auth, body, key);
  }

  @Post('debit-notes')
  @RequirePermissions(NOTES_PERMISSION)
  debitNote(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(debitNoteSchema)) body: DebitNoteInput,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) key: string | undefined,
  ): Promise<NoteView> {
    return this.issuing.debitNote(auth, body, key);
  }

  @Get('notes')
  @RequirePermissions('sales:read')
  listNotes(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listNotesSchema)) query: ListNotesQuery,
  ): Promise<NotePage> {
    return this.notes.listNotes(auth, query);
  }

  @Get('notes/:id')
  @RequirePermissions('sales:read')
  getNote(@CurrentAuth() auth: AuthContext, @Param('id', id()) noteId: string): Promise<NoteView> {
    return this.notes.getNote(auth, noteId);
  }

  @Get('invoices/:id/adjustments')
  @RequirePermissions('sales:read')
  adjustments(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
  ): Promise<InvoiceAdjustments> {
    return this.notes.adjustments(auth, invoiceId);
  }
}
