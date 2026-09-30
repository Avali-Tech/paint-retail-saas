import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DatabaseConnection } from '@paint/db';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';

/** Builds and initialises the Nest app without listening, so tests can drive it directly. */
export async function createApp(
  config: AppConfig,
  connection: DatabaseConnection,
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(connection),
    new FastifyAdapter(),
    { logger: createLogger(config) },
  );
  app.enableShutdownHooks();
  await app.init();
  return app;
}
