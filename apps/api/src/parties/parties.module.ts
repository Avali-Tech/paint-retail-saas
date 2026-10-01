import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';
import { PartyOverviewService } from './party-overview.service.js';

@Module({
  controllers: [PartiesController],
  providers: [PartiesService, PartyOverviewService],
})
export class PartiesModule {}
