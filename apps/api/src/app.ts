import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DatabaseConnection } from '@paint/db';
import { AppModule } from './app.module.js';
import type { SmsSender } from './auth/sms.js';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';

/** Builds and initialises the Nest app without listening, so tests can drive it directly. */
export async function createApp(
  config: AppConfig,
  connection: DatabaseConnection,
  overrides: { smsSender?: SmsSender } = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ config, connection, ...overrides }),
    new FastifyAdapter(),
    { logger: createLogger(config) },
  );
  app.enableShutdownHooks();
  await app.init();
  return app;
}
