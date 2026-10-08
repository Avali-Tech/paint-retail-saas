import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { DispatchesService } from './dispatches.service.js';
import { GoLiveService } from './go-live.service.js';
import {
  DispatchesController,
  GoLiveController,
  QuotationsController,
  SalesOrdersController,
  StockReservationsController,
} from './orders.controller.js';
import { QuotationsService } from './quotations.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

/**
 * Sell & Bill, round 4a: quotations, sales orders with credit check and
 * reservations, dispatches, and the billing go-live cut-over.
 */
@Module({
  controllers: [
    QuotationsController,
    SalesOrdersController,
    StockReservationsController,
    DispatchesController,
    GoLiveController,
  ],
  providers: [QuotationsService, SalesOrdersService, DispatchesService, GoLiveService],
})
export class OrdersModule {}
