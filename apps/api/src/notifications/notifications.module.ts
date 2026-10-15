import 'reflect-metadata';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { SmsSender } from '../auth/sms.js';
import type { MessagingProvider } from '../messaging/messaging-provider.js';
import { SmtpEmailSender } from './email-sender.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import {
  NotificationsWorker,
  WORKER_SETTINGS,
  type WorkerSettings,
} from './notifications-worker.js';
import { NOTIFIER_SETTINGS, Notifier, type NotifierSettings } from './notifier.js';

export interface NotificationsOptions {
  readonly appUrl: string;
  readonly email: { readonly smtpUrl: string; readonly from: string } | null;
  readonly workerIntervalSeconds: number;
  /** Who sends WhatsApp and SMS messages to parties; null where off. */
  readonly messaging: {
    readonly whatsapp: MessagingProvider | null;
    readonly sms: SmsSender | null;
  };
}

/** Global, so any module can inject the Notifier to report events. */
@Global()
@Module({})
export class NotificationsModule {
  static forRoot(options: NotificationsOptions): DynamicModule {
    const notifier: NotifierSettings = {
      appUrl: options.appUrl,
      emailEnabled: options.email !== null,
    };
    const worker: WorkerSettings = {
      intervalMs: options.workerIntervalSeconds * 1000,
      sender: options.email && new SmtpEmailSender(options.email.smtpUrl, options.email.from),
      messaging: options.messaging,
      clock: () => new Date(),
    };
    return {
      module: NotificationsModule,
      controllers: [NotificationsController],
      providers: [
        NotificationsService,
        Notifier,
        NotificationsWorker,
        { provide: NOTIFIER_SETTINGS, useValue: notifier },
        { provide: WORKER_SETTINGS, useValue: worker },
      ],
      exports: [Notifier],
    };
  }
}
