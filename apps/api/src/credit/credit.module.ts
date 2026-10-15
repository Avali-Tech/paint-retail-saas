import 'reflect-metadata';
import { Module } from '@nestjs/common';
import {
  CreditApprovalsController,
  SiteAccountsController,
} from './credit-approvals.controller.js';
import { CreditApprovalsService } from './credit-approvals.service.js';
import { CreditController } from './credit.controller.js';
import { CreditService } from './credit.service.js';
import { SiteAccountsService } from './site-accounts.service.js';

@Module({
  controllers: [CreditController, CreditApprovalsController, SiteAccountsController],
  providers: [CreditService, CreditApprovalsService, SiteAccountsService],
})
export class CreditModule {}
