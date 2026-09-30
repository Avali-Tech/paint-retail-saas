import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseConnection } from '@paint/db';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

@Module({})
export class AppModule {
  static forRoot(connection: DatabaseConnection): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.forRoot(connection), HealthModule],
    };
  }
}
