import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AUTH_SETTINGS, SMS_SENDER, type AuthSettings } from './auth.tokens.js';
import { PermissionsGuard } from './permissions.guard.js';
import { ReadOnlyGuard } from '../subscriptions/read-only.guard.js';
import { TwoFactorController } from './two-factor.controller.js';
import { TwoFactorService } from './two-factor.service.js';
import type { SmsSender } from './sms.js';

@Module({})
export class AuthModule {
  static forRoot(options: { settings: AuthSettings; smsSender: SmsSender }): DynamicModule {
    return {
      module: AuthModule,
      // Global, so the platform console can use two-factor sign-in too.
      global: true,
      controllers: [AuthController, TwoFactorController],
      providers: [
        AuthService,
        TwoFactorService,
        { provide: AUTH_SETTINGS, useValue: options.settings },
        { provide: SMS_SENDER, useValue: options.smsSender },
        // Order matters: AuthGuard identifies the user, then PermissionsGuard checks them,
        // then ReadOnlyGuard holds back changes while the subscription does not allow them.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: ReadOnlyGuard },
      ],
      exports: [AuthService, TwoFactorService],
    };
  }
}
