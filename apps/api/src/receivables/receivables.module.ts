import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ReceivablesController } from './receivables.controller.js';
import { ReceivablesService } from './receivables.service.js';

/** Release 2.1, P2-M10: receivables and ageing, read from the 2.0 books. */
@Module({
  controllers: [ReceivablesController],
  providers: [ReceivablesService],
})
export class ReceivablesModule {}
