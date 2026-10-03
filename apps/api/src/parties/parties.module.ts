import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';
import { PartyMergeController } from './party-merge.controller.js';
import { PartyMergeService } from './party-merge.service.js';
import { PartyOverviewService } from './party-overview.service.js';

@Module({
  controllers: [PartiesController, PartyMergeController],
  providers: [PartiesService, PartyOverviewService, PartyMergeService],
})
export class PartiesModule {}
