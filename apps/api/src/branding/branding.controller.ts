import 'reflect-metadata';
import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { BrandingSaved, BrandingView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { BrandingService } from './branding.service.js';

@Controller('organization/branding')
export class BrandingController {
  constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

  /** For any signed-in member, so the app can wear the business's look. */
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<BrandingView> {
    return this.branding.get(auth);
  }

  /** Validated by validateBranding from @paint/shared, the same rules the browser uses. */
  @Put()
  @RequirePermissions('organization:manage')
  set(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<BrandingSaved> {
    return this.branding.set(auth, body);
  }
}
