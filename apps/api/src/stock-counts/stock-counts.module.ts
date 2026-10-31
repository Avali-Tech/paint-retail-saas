import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { StockCountsController } from './stock-counts.controller.js';
import { StockCountsService } from './stock-counts.service.js';

@Module({
  controllers: [StockCountsController],
  providers: [StockCountsService],
  // The inbox reads these queues.
  exports: [StockCountsService],
})
export class StockCountsModule {}
