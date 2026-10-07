import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { BillingSettingsController } from './billing-settings.controller.js';
import { BillingSettingsService } from './billing-settings.service.js';
import { InvoiceIssueService } from './invoice-issue.service.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesService } from './invoices.service.js';

/** Sell & Bill, round 2a: invoices and bills of supply, series, settings and GSTIN profiles. */
@Module({
  controllers: [InvoicesController, BillingSettingsController],
  providers: [InvoicesService, InvoiceIssueService, BillingSettingsService],
})
export class BillingModule {}
