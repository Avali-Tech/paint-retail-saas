import 'reflect-metadata';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';

export interface HealthReport {
  readonly status: 'ok' | 'error';
  readonly checks?: { readonly database: 'up' | 'down' };
}

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: the process is running. Used to decide whether to restart it. */
  @Get()
  live(): HealthReport {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable. Used to decide whether to send it traffic. */
  @Get('ready')
  async ready(): Promise<HealthReport> {
    if (await this.health.isDatabaseUp()) {
      return { status: 'ok', checks: { database: 'up' } };
    }
    throw new ServiceUnavailableException({ status: 'error', checks: { database: 'down' } });
  }
}
