import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { BrandSchemesController } from './brand-schemes.controller.js';
import { BrandSchemesService } from './brand-schemes.service.js';

@Module({
  controllers: [BrandSchemesController],
  providers: [BrandSchemesService],
})
export class BrandSchemesModule {}
