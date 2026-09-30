import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, migrateDatabase } from '@paint/db';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Starts the API: validates config, optionally applies migrations, connects to
 * PostgreSQL and listens for HTTP requests.
 */
export async function bootstrap(
  env: Record<string, string | undefined>,
): Promise<NestFastifyApplication> {
  const config = loadConfig(env);
  if (config.runMigrations) {
    await migrateDatabase(config.databaseUrl);
  }
  const app = await createApp(config, createDatabase(config.databaseUrl));
  await app.listen({ host: config.host, port: config.port });
  return app;
}
