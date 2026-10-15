import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PointsNotices } from '../loyalty/points-notice.js';
import { BillingSettingsController } from './billing-settings.controller.js';
import { BillingSettingsService } from './billing-settings.service.js';
import { InvoiceIssueService } from './invoice-issue.service.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';
import { NoteIssueService } from './note-issue.service.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

/**
 * Sell & Bill: invoices and bills of supply, series, settings and GSTIN profiles
 * (round 2a); sales returns, credit and debit notes (round 3c).
 */
@Module({
  controllers: [InvoicesController, BillingSettingsController, NotesController],
  providers: [
    InvoicesService,
    InvoiceIssueService,
    BillingSettingsService,
    NoteIssueService,
    NotesService,
    PointsNotices,
  ],
})
export class BillingModule {}
