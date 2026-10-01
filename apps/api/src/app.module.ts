import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseConnection } from '@paint/db';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { authSettingsFrom } from './auth/auth.tokens.js';
import { smsSenderFor, type SmsSender } from './auth/sms.js';
import type { AppConfig } from './config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { MembersModule } from './members/members.module.js';
import { PartiesModule } from './parties/parties.module.js';
import { StoresModule } from './stores/stores.module.js';
import { TransfersModule } from './transfers/transfers.module.js';

export interface AppModuleOptions {
  readonly config: AppConfig;
  readonly connection: DatabaseConnection;
  /** Replaces the configured SMS sender (tests capture codes this way). */
  readonly smsSender?: SmsSender;
}

@Module({})
export class AppModule {
  static forRoot({ config, connection, smsSender }: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forRoot(connection),
        AuthModule.forRoot({
          settings: authSettingsFrom(config),
          smsSender: smsSender ?? smsSenderFor(config.smsProvider),
        }),
        CatalogModule,
        HealthModule,
        InventoryModule,
        MembersModule,
        PartiesModule,
        StoresModule,
        TransfersModule,
      ],
    };
  }
}
