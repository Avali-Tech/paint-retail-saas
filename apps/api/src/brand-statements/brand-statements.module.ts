import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { BrandStatementsController } from './brand-statements.controller.js';
import { BrandStatementsService } from './brand-statements.service.js';

@Module({
  controllers: [BrandStatementsController],
  providers: [BrandStatementsService],
})
export class BrandStatementsModule {}
