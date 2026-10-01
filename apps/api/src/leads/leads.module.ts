import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller.js';
import { LeadsService } from './leads.service.js';
import { OpportunitiesController } from './opportunities.controller.js';
import { OpportunitiesService } from './opportunities.service.js';

@Module({
  controllers: [LeadsController, OpportunitiesController],
  providers: [LeadsService, OpportunitiesService],
})
export class LeadsModule {}
