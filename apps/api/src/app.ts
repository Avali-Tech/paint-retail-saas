import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DatabaseConnection } from '@paint/db';
import { AppModule } from './app.module.js';
import type { SmsSender } from './auth/sms.js';
import type { AppConfig } from './config.js';
import { MAX_DOCUMENT_BYTES } from './documents/file-checks.js';
import { createLogger } from './logger.js';

/** Builds and initialises the Nest app without listening, so tests can drive it directly. */
export async function createApp(
  config: AppConfig,
  connection: DatabaseConnection,
  overrides: { smsSender?: SmsSender } = {},
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ config, connection, ...overrides }),
    // CSV imports of up to 5,000 rows need more than Fastify's 1 MB default.
    new FastifyAdapter({ bodyLimit: 4 * 1024 * 1024 }),
    // The raw body too: payment gateways sign it, and their webhooks are checked against it.
    { logger: createLogger(config), rawBody: true },
  );
  // Document uploads: one file of at most 10 MB; larger ones are cut short and refused.
  await app.register(multipart, {
    limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 10, fieldSize: 1024 },
    throwFileSizeLimit: false,
  });
  app.enableShutdownHooks();
  await app.init();
  return app;
}
