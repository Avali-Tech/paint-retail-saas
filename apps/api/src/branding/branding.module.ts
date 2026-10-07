import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { BrandingController } from './branding.controller.js';
import { BrandingService } from './branding.service.js';
import { IdentityController } from './identity.controller.js';
import { IdentityService } from './identity.service.js';
import { PublicBrandingController } from './public-branding.controller.js';
import { PublicBrandingService } from './public-branding.service.js';

// Logos are scanned and stored with DOCUMENT_SERVICES, provided globally by DocumentsModule.
@Module({
  controllers: [BrandingController, IdentityController, PublicBrandingController],
  providers: [BrandingService, IdentityService, PublicBrandingService],
})
export class BrandingModule {}
