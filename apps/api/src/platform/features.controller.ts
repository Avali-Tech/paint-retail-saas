import 'reflect-metadata';
import { Controller, Get, Inject } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { TenantsService } from './tenants.service.js';

/** For any signed-in member: what their plan includes, so the app can show or hide features. */
@Controller('organization/features')
export class FeaturesController {
  constructor(@Inject(TenantsService) private readonly tenants: TenantsService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext): ReturnType<TenantsService['features']> {
    return this.tenants.features(auth);
  }
}
