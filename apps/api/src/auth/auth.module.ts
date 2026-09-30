import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AUTH_SETTINGS, SMS_SENDER, type AuthSettings } from './auth.tokens.js';
import { PermissionsGuard } from './permissions.guard.js';
import type { SmsSender } from './sms.js';

@Module({})
export class AuthModule {
  static forRoot(options: { settings: AuthSettings; smsSender: SmsSender }): DynamicModule {
    return {
      module: AuthModule,
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: AUTH_SETTINGS, useValue: options.settings },
        { provide: SMS_SENDER, useValue: options.smsSender },
        // Order matters: AuthGuard identifies the user, then PermissionsGuard checks them.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
      ],
      exports: [AuthService],
    };
  }
}
