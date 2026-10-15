import 'reflect-metadata';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { MessagingController } from './messaging.controller.js';
import {
  MESSAGING_SETTINGS,
  MessagingService,
  type MessagingSettings,
} from './messaging.service.js';

/**
 * Release 2.1, P2-M32 (messaging half): consent, templates and the message log.
 * Global so other modules can read the settings (e.g. whether WhatsApp is on).
 */
@Global()
@Module({})
export class MessagingModule {
  static forRoot(settings: MessagingSettings): DynamicModule {
    return {
      module: MessagingModule,
      controllers: [MessagingController],
      providers: [MessagingService, { provide: MESSAGING_SETTINGS, useValue: settings }],
      exports: [MESSAGING_SETTINGS],
    };
  }
}
