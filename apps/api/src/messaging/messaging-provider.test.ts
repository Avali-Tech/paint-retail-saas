import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogMessagingProvider, messagingProviderFor } from './messaging-provider.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('messaging providers', () => {
  it('chooses the log provider, or none when WhatsApp is off', () => {
    expect(messagingProviderFor('log')).toBeInstanceOf(LogMessagingProvider);
    expect(messagingProviderFor('disabled')).toBeNull();
  });

  it('prints a message and answers with a reference from its idempotency key', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = new LogMessagingProvider();

    const sent = await provider.send({
      to: '+919811100032',
      template: { key: 'statement_ready', name: null, language: 'hi' },
      variables: { name: 'Ravi' },
      body: 'प्रिय Ravi',
      idempotencyKey: 'abc',
    });

    expect(provider.name).toBe('log');
    expect(sent).toEqual({ providerRef: 'log-abc' });
    expect(warn).toHaveBeenCalledWith('To +919811100032 (statement_ready, hi): प्रिय Ravi');
  });
});
