import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { EstimatesService } from './estimates.service.js';
import { EstimatesController, TintRecordsController } from './paint.controller.js';
import { TintRecordsService } from './tint-records.service.js';

/** Sell & Bill, round 5a: tint records with the shade history, and paint estimates. */
@Module({
  imports: [OrdersModule],
  controllers: [TintRecordsController, EstimatesController],
  providers: [TintRecordsService, EstimatesService],
})
export class PaintModule {}
