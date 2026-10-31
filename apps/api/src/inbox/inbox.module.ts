import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ActivitiesModule } from '../activities/activities.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { CreditModule } from '../credit/credit.module.js';
import { ReorderModule } from '../reorder/reorder.module.js';
import { StockCountsModule } from '../stock-counts/stock-counts.module.js';
import { TransfersModule } from '../transfers/transfers.module.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';

/** The "Needs action" inbox (docs/mvp-3/navigation-ux.md, step 2). */
@Module({
  imports: [
    ActivitiesModule,
    CollectionsModule,
    CreditModule,
    ReorderModule,
    StockCountsModule,
    TransfersModule,
  ],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
