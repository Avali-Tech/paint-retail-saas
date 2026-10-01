import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { GoodsReceiptsController } from './goods-receipts.controller.js';
import { GoodsReceiptsService } from './goods-receipts.service.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({
  controllers: [SuppliersController, PurchaseOrdersController, GoodsReceiptsController],
  providers: [SuppliersService, PurchaseOrdersService, GoodsReceiptsService],
})
export class PurchasingModule {}
