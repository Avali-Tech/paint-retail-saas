import 'reflect-metadata';
import { Controller, Get, Inject } from '@nestjs/common';
import type { SetupChecklistView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { OnboardingService } from './onboarding.service.js';

@Controller('onboarding')
export class OnboardingController {
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  /** The "Getting started" checklist. Open to every member: it shows progress, not records. */
  @Get()
  get(@CurrentAuth() auth: AuthContext): Promise<SetupChecklistView> {
    return this.onboarding.get(auth);
  }
}
