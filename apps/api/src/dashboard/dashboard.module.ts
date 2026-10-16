import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { SalesOverviewService } from './sales-overview.service.js';

@Module({
  controllers: [DashboardController],
  providers: [DashboardService, SalesOverviewService],
})
export class DashboardModule {}
