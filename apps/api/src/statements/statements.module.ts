import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { StatementsController } from './statements.controller.js';
import { StatementsService } from './statements.service.js';

/** Release 2.1, P2-M12: customer statements, from the party ledger. */
@Module({
  controllers: [StatementsController],
  providers: [StatementsService],
})
export class StatementsModule {}
