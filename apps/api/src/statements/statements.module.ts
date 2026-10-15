import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import {
  STATEMENT_LINK_SETTINGS,
  StatementLinksService,
  type StatementLinkSettings,
} from './statement-links.service.js';
import {
  PublicStatementsController,
  StatementLinksController,
  StatementsController,
} from './statements.controller.js';
import { StatementsService } from './statements.service.js';

/** Release 2.1, P2-M12: customer statements, from the party ledger, and stored links. */
@Module({})
export class StatementsModule {
  static forRoot(settings: StatementLinkSettings): DynamicModule {
    return {
      module: StatementsModule,
      controllers: [StatementsController, StatementLinksController, PublicStatementsController],
      providers: [
        StatementsService,
        StatementLinksService,
        { provide: STATEMENT_LINK_SETTINGS, useValue: settings },
      ],
    };
  }
}
