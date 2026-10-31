import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ActivitiesController } from './activities.controller.js';
import { ActivitiesService } from './activities.service.js';

@Module({
  controllers: [ActivitiesController],
  providers: [ActivitiesService],
  // The inbox reads these queues.
  exports: [ActivitiesService],
})
export class ActivitiesModule {}
