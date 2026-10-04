import 'reflect-metadata';
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  ServiceUnavailableException,
  type ArgumentsHost,
  type HttpServer,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorTracker } from './error-tracker.js';
import { ErrorTrackingFilter } from './error-tracking.filter.js';
import { setActiveErrorTracker } from './active-tracker.js';
import { DISABLED_ERROR_TRACKER } from './error-tracker.js';
import { ObservabilityModule, SHUTDOWN_FLUSH_MS } from './observability.module.js';

@Controller('probe')
class ProbeController {
  @Get('crash')
  crash(): never {
    throw new Error('database said: password=hunter2');
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException();
  }

  @Get('plugin-error')
  pluginError(): Promise<never> {
    // Shaped like errors from Fastify plugins and http-errors: Nest answers with its status.
    return Promise.reject({ statusCode: 413, message: 'Payload too large' });
  }

  @Get('invalid')
  invalid(): never {
    throw new BadRequestException('mobile is required');
  }

  @Get('ok')
  ok() {
    return { ok: true };
  }
}

function fakeTracker() {
  return {
    enabled: true,
    capture: vi.fn<ErrorTracker['capture']>(),
    flush: vi.fn<ErrorTracker['flush']>(() => Promise.resolve(true)),
  };
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  setActiveErrorTracker(DISABLED_ERROR_TRACKER);
});

async function start(tracker?: ErrorTracker): Promise<NestFastifyApplication> {
  @Module({ imports: [ObservabilityModule.forRoot(tracker)], controllers: [ProbeController] })
  class ProbeModule {}
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('ObservabilityModule', () => {
  it('reports unexpected errors with the request id, method and route, then answers 500', async () => {
    const tracker = fakeTracker();
    const server = await start(tracker);

    const response = await server.inject({
      method: 'GET',
      url: '/probe/crash?mobile=9876543210',
      headers: { 'x-request-id': 'support-ticket-0042' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(response.headers['x-request-id']).toBe('support-ticket-0042');
    expect(tracker.capture).toHaveBeenCalledWith(expect.any(Error), {
      requestId: 'support-ticket-0042',
      method: 'GET',
      route: '/probe/crash',
      status: 500,
    });
  });

  it('reports other 5xx answers but not client errors or successes', async () => {
    const tracker = fakeTracker();
    const server = await start(tracker);

    const unavailable = await server.inject({ method: 'GET', url: '/probe/unavailable' });
    const tooLarge = await server.inject({ method: 'GET', url: '/probe/plugin-error' });
    const invalid = await server.inject({ method: 'GET', url: '/probe/invalid' });
    const ok = await server.inject({ method: 'GET', url: '/probe/ok' });

    expect([
      unavailable.statusCode,
      tooLarge.statusCode,
      invalid.statusCode,
      ok.statusCode,
    ]).toEqual([503, 413, 400, 200]);
    expect(tracker.capture).toHaveBeenCalledTimes(1);
    expect(tracker.capture.mock.calls[0]?.[1]).toMatchObject({ status: 503 });
    // Every answer carries a generated id when the caller sent none.
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('flushes queued reports when the app shuts down', async () => {
    const tracker = fakeTracker();
    const server = await start(tracker);

    await server.close();
    app = undefined;

    expect(tracker.flush).toHaveBeenCalledWith(SHUTDOWN_FLUSH_MS);
  });

  it('reports through the tracker started in main.ts when none is given', async () => {
    const tracker = fakeTracker();
    setActiveErrorTracker(tracker);
    const server = await start();

    await server.inject({ method: 'GET', url: '/probe/crash' });

    expect(tracker.capture).toHaveBeenCalledTimes(1);
  });

  it('answers as usual with error tracking off', async () => {
    const server = await start();

    const response = await server.inject({ method: 'GET', url: '/probe/crash' });

    expect(response.statusCode).toBe(500);
  });
});

describe('ErrorTrackingFilter', () => {
  it('does not report errors outside HTTP requests', () => {
    const tracker = fakeTracker();
    const reply = vi.fn();
    const applicationRef = { isHeadersSent: () => false, reply } as unknown as HttpServer;
    const host = { getType: () => 'rpc', getArgByIndex: () => ({}) } as unknown as ArgumentsHost;

    new ErrorTrackingFilter(tracker, applicationRef).catch(new Error('x'), host);

    expect(tracker.capture).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalled();
  });

  it('reads the status the way Nest answers: HTTP exceptions, http-error shapes, else 500', () => {
    const filter = new ErrorTrackingFilter(fakeTracker(), {} as HttpServer);
    expect(filter.statusOf(new BadRequestException())).toBe(400);
    expect(filter.statusOf({ statusCode: 415, message: 'Unsupported' })).toBe(415);
    expect(filter.statusOf(Object.assign(new Error('x'), { statusCode: 415 }))).toBe(500);
    expect(filter.statusOf(null)).toBe(500);
  });
});
