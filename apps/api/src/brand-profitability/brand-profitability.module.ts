import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ReportsService } from '../reports/reports.service.js';
import { BrandProfitabilityController } from './brand-profitability.controller.js';

/** Release 2.1, P2-M35: brand profitability, read from the books. */
@Module({
  controllers: [BrandProfitabilityController],
  providers: [ReportsService],
})
export class BrandProfitabilityModule {}
