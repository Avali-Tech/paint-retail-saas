import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PartyLedgerService } from './party-ledger.service.js';
import { PaymentModesService } from './payment-modes.service.js';
import {
  PartyLedgerController,
  PaymentModesController,
  PaymentsController,
  RegisterSessionsController,
  RegistersController,
} from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RegistersService } from './registers.service.js';

/** Sell & Bill, round 3a: payments, allocations, cheques, refunds and the cash register. */
@Module({
  controllers: [
    PaymentsController,
    PaymentModesController,
    PartyLedgerController,
    RegistersController,
    RegisterSessionsController,
  ],
  providers: [PaymentsService, PaymentModesService, PartyLedgerService, RegistersService],
})
export class PaymentsModule {}
