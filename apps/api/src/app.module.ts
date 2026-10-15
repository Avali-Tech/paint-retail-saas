import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { DatabaseConnection } from '@paint/db';
import { AccountingModule } from './accounting/accounting.module.js';
import { ActivitiesModule } from './activities/activities.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { BrandingModule } from './branding/branding.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { ContractsModule } from './contracts/contracts.module.js';
import { CreditModule } from './credit/credit.module.js';
import { authSettingsFrom } from './auth/auth.tokens.js';
import { smsSenderFor, type SmsSender } from './auth/sms.js';
import type { AppConfig } from './config.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthModule } from './health/health.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { LoyaltyModule } from './loyalty/loyalty.module.js';
import { MembersModule } from './members/members.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ObservabilityModule } from './observability/index.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaintModule } from './paint/paint.module.js';
import { PartiesModule } from './parties/parties.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { PurchasingModule } from './purchasing/purchasing.module.js';
import { ReceivablesModule } from './receivables/receivables.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { ReorderModule } from './reorder/reorder.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { SearchModule } from './search/search.module.js';
import { StatementsModule } from './statements/statements.module.js';
import { StockCountsModule } from './stock-counts/stock-counts.module.js';
import { StoresModule } from './stores/stores.module.js';
import { TaxModule } from './tax/tax.module.js';
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
        ObservabilityModule.forRoot(),
        AccountingModule,
        ActivitiesModule,
        AuditModule,
        BillingModule,
        BrandingModule,
        DashboardModule,
        AuthModule.forRoot({
          settings: authSettingsFrom(config),
          smsSender: smsSender ?? smsSenderFor(config.smsProvider),
        }),
        CatalogModule,
        ContractsModule,
        CreditModule,
        DocumentsModule.forRoot(config.documents),
        HealthModule,
        ImportsModule,
        InventoryModule,
        LeadsModule,
        LoyaltyModule,
        MembersModule,
        NotificationsModule.forRoot({
          appUrl: config.appUrl,
          email: config.email,
          workerIntervalSeconds: config.workerIntervalSeconds,
        }),
        OnboardingModule,
        OrdersModule,
        PaintModule,
        PartiesModule,
        PaymentsModule,
        PlatformModule.forRoot({ bootstrapToken: config.platformBootstrapToken }),
        ProjectsModule,
        PurchasingModule,
        ReceivablesModule,
        ReconciliationModule,
        ReorderModule,
        ReportsModule,
        SearchModule,
        StatementsModule,
        StockCountsModule,
        StoresModule,
        TaxModule,
        TransfersModule,
      ],
    };
  }
}
