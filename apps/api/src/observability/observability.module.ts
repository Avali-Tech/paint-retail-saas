import 'reflect-metadata';
import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { APP_FILTER, HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { activeErrorTracker } from './active-tracker.js';
import type { ErrorTracker } from './error-tracker.js';
import { ErrorTrackingFilter } from './error-tracking.filter.js';
import { installRequestIds } from './request-id.js';

export const ERROR_TRACKER = Symbol('ERROR_TRACKER');

/** How long shutdown waits for queued error reports. */
export const SHUTDOWN_FLUSH_MS = 2_000;

/** Sends any queued error reports before the process exits (deploys stop tasks with SIGTERM). */
@Injectable()
export class ErrorTrackingShutdown implements OnApplicationShutdown {
  constructor(@Inject(ERROR_TRACKER) private readonly tracker: ErrorTracker) {}

  async onApplicationShutdown(): Promise<void> {
    await this.tracker.flush(SHUTDOWN_FLUSH_MS);
  }
}

/** Unique request ids, echoed as X-Request-Id; installed while the app initialises. */
@Injectable()
export class RequestIds implements OnModuleInit {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    installRequestIds(this.adapterHost.httpAdapter.getInstance<FastifyInstance>());
  }
}

/**
 * Request ids, and reports of 5xx answers to error tracking (Sentry). Uses the tracker
 * started by startErrorTracking() in main.ts unless one is given (tests); with
 * tracking off it only answers as Nest would.
 */
@Module({})
export class ObservabilityModule {
  static forRoot(tracker?: ErrorTracker): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        { provide: ERROR_TRACKER, useFactory: () => tracker ?? activeErrorTracker() },
        ErrorTrackingShutdown,
        RequestIds,
        {
          provide: APP_FILTER,
          useFactory: (active: ErrorTracker, adapterHost: HttpAdapterHost) =>
            new ErrorTrackingFilter(active, adapterHost.httpAdapter),
          inject: [ERROR_TRACKER, HttpAdapterHost],
        },
      ],
    };
  }
}
