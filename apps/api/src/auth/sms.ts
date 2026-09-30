import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { SmsProvider } from '../config.js';

/** Delivers a text message. Real providers (e.g. MSG91) plug in behind this interface. */
export interface SmsSender {
  send(phone: string, message: string): Promise<void>;
}

/** Development only: prints messages (including sign-in codes) to the log. */
export class LoggingSmsSender implements SmsSender {
  private readonly logger = new Logger('SMS');

  send(phone: string, message: string): Promise<void> {
    this.logger.warn(`To ${phone}: ${message}`);
    return Promise.resolve();
  }
}

/** Used until a real SMS provider is configured: OTP sign-in answers 503. */
export class DisabledSmsSender implements SmsSender {
  send(): Promise<void> {
    return Promise.reject(
      new ServiceUnavailableException(
        'Sign-in by SMS code is not available yet. Use your password.',
      ),
    );
  }
}

export function smsSenderFor(provider: SmsProvider): SmsSender {
  return provider === 'log' ? new LoggingSmsSender() : new DisabledSmsSender();
}
