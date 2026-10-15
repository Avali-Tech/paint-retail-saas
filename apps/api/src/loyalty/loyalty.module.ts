import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { EarnRulesController } from './earn-rules.controller.js';
import { EarnRulesService } from './earn-rules.service.js';
import { LoyaltyController } from './loyalty.controller.js';
import { LoyaltyService } from './loyalty.service.js';

@Module({
  controllers: [LoyaltyController, EarnRulesController],
  providers: [LoyaltyService, EarnRulesService],
})
export class LoyaltyModule {}
