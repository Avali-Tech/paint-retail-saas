import 'reflect-metadata';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { DatabaseConnection } from '@paint/db';

/** Injection token for the app's DatabaseConnection. */
export const DATABASE = Symbol('DATABASE');

/** Closes the connection pool when the app shuts down (e.g. on SIGTERM during a deploy). */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}

/** Makes one shared DatabaseConnection available everywhere via @Inject(DATABASE). */
@Global()
@Module({})
export class DatabaseModule {
  static forRoot(connection: DatabaseConnection): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [{ provide: DATABASE, useValue: connection }, DatabaseLifecycle],
      exports: [DATABASE],
    };
  }
}
