import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller.js';
import { CollectionsService } from './collections.service.js';

/** Release 2.1, P2-M11: collections. The daily job runs in the notifications worker. */
@Module({
  controllers: [CollectionsController],
  providers: [CollectionsService],
  // The inbox reads these queues.
  exports: [CollectionsService],
})
export class CollectionsModule {}
