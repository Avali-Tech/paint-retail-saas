import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { FeaturesController } from './features.controller.js';
import {
  PLATFORM_SETTINGS,
  PlatformAuthService,
  type PlatformSettings,
} from './platform-auth.service.js';
import { PlatformAuthController, TenantsController } from './platform.controller.js';
import { PlatformGuard } from './platform.guard.js';
import { TenantsService } from './tenants.service.js';

@Module({})
export class PlatformModule {
  static forRoot(settings: PlatformSettings): DynamicModule {
    return {
      module: PlatformModule,
      controllers: [PlatformAuthController, TenantsController, FeaturesController],
      providers: [
        PlatformAuthService,
        PlatformGuard,
        TenantsService,
        { provide: PLATFORM_SETTINGS, useValue: settings },
      ],
    };
  }
}
