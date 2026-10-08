import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { AccountingExportsService } from './accounting-exports.service.js';
import { AccountingExportsController, LedgerMappingsController } from './accounting.controller.js';
import { LedgerMappingsService } from './ledger-mappings.service.js';

/** Sell & Bill, round 4c: ledger-mapping settings and the Tally export. */
@Module({
  controllers: [LedgerMappingsController, AccountingExportsController],
  providers: [LedgerMappingsService, AccountingExportsService],
})
export class AccountingModule {}
