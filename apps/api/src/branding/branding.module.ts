import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';

@Module({
  controllers: [BrandingController],
  providers: [BrandingService],
})
export class BrandingModule {}
