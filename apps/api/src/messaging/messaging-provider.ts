import { Logger } from '@nestjs/common';
import type { MessageLanguage, TemplateKey } from '@paint/shared';
import type { MessagingProvider as MessagingProviderName } from '../config.js';

/**
 * One WhatsApp template message (P2-M32, spec §6.2). Every message we start is an
 * approved template with variables; the row id of the outbox is the idempotency
 * key, so a retry never sends twice (spec MSG-7, after draft PR #51 WA-7).
 */
export interface TemplateMessage {
  /** E.164 mobile number, as consented. */
  readonly to: string;
  readonly template: {
    readonly key: TemplateKey;
    /** The name the BSP approved it under; null until the business has one ([PO-1]). */
    readonly name: string | null;
    readonly language: MessageLanguage;
  };
  readonly variables: Readonly<Record<string, string>>;
  /** The text as rendered, for providers (and logs) that need it. */
  readonly body: string;
  readonly idempotencyKey: string;
}

/**
 * Sends WhatsApp messages to parties. `log` prints them (development, tests and
 * demos); a BSP adapter (Gupshup, Interakt, AiSensy or Meta Cloud API, [PO-1])
 * implements the same interface, chosen by MESSAGING_PROVIDER.
 */
export interface MessagingProvider {
  /** Stored on each message sent, e.g. "log". */
  readonly name: string;
  send(message: TemplateMessage): Promise<{ readonly providerRef: string }>;
}

/** Development only: prints each message to the log instead of sending it. */
export class LogMessagingProvider implements MessagingProvider {
  readonly name = 'log';
  private readonly logger = new Logger('WhatsApp');

  send(message: TemplateMessage): Promise<{ providerRef: string }> {
    this.logger.warn(
      `To ${message.to} (${message.template.key}, ${message.template.language}): ${message.body}`,
    );
    return Promise.resolve({ providerRef: `log-${message.idempotencyKey}` });
  }
}

/** The configured provider; null when WhatsApp is off (messages are then skipped). */
export function messagingProviderFor(name: MessagingProviderName): MessagingProvider | null {
  return name === 'log' ? new LogMessagingProvider() : null;
}
