import 'reflect-metadata';
import { Catch, HttpException, type ArgumentsHost, type HttpServer } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { ErrorTracker } from './error-tracker.js';

/**
 * Reports server errors (5xx, including unexpected exceptions) to error tracking,
 * then answers exactly as Nest would without it. Client errors (4xx) are not reported.
 */
@Catch()
export class ErrorTrackingFilter extends BaseExceptionFilter {
  constructor(
    private readonly tracker: ErrorTracker,
    applicationRef: HttpServer,
  ) {
    super(applicationRef);
  }

  /** The status Nest's own handling answers with (see BaseExceptionFilter). */
  statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    return this.isHttpError(exception) ? exception.statusCode : 500;
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    const status = this.statusOf(exception);
    if (status >= 500 && host.getType() === 'http') {
      const request = host.switchToHttp().getRequest<FastifyRequest>();
      this.tracker.capture(exception, {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        status,
      });
    }
    super.catch(exception, host);
  }
}
