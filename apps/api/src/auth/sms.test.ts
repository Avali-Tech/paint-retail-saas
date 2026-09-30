import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisabledSmsSender, LoggingSmsSender, smsSenderFor } from './sms.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('smsSenderFor', () => {
  it('picks the sender for each provider', () => {
    expect(smsSenderFor('log')).toBeInstanceOf(LoggingSmsSender);
    expect(smsSenderFor('disabled')).toBeInstanceOf(DisabledSmsSender);
  });
});

describe('LoggingSmsSender', () => {
  it('writes the message to the log instead of sending it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await new LoggingSmsSender().send('+919800000001', '123456 is your code');

    expect(warn).toHaveBeenCalledWith('To +919800000001: 123456 is your code');
  });
});

describe('DisabledSmsSender', () => {
  it('refuses with 503 so the client can suggest password sign-in', async () => {
    await expect(new DisabledSmsSender().send()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
