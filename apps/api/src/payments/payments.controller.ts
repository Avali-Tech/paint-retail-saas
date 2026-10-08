import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  PartyLedgerView,
  PaymentModeView,
  PaymentPage,
  PaymentView,
  ReceiptView,
  RegisterSessionSummary,
  RegisterSessionView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { idempotencyKeySchema } from '../billing/billing.schemas.js';
import { IdempotencyKey } from '../billing/idempotency.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PartyLedgerService } from './party-ledger.service.js';
import { PaymentModesService } from './payment-modes.service.js';
import {
  allocatePaymentSchema,
  bounceChequeSchema,
  cashMovementSchema,
  clearChequeSchema,
  closeRegisterSchema,
  createPaymentModeSchema,
  listPaymentsSchema,
  listRegisterSessionsSchema,
  openRegisterSchema,
  partyLedgerQuerySchema,
  recordPaymentSchema,
  refundSchema,
  registerCodeSchema,
  updatePaymentModeSchema,
  type AllocatePaymentInput,
  type BounceChequeInput,
  type CashMovementInput,
  type ClearChequeInput,
  type CloseRegisterInput,
  type CreatePaymentModeInput,
  type ListPaymentsQuery,
  type ListRegisterSessionsQuery,
  type OpenRegisterInput,
  type PartyLedgerQuery,
  type RecordPaymentInput,
  type RefundInput,
  type UpdatePaymentModeInput,
} from './payments.schemas.js';
import { PaymentsService } from './payments.service.js';
import { RegistersService } from './registers.service.js';

const id = () => new ParseUUIDPipe();
const key = () => new ZodValidationPipe(idempotencyKeySchema);

/** Money received and refunded: receipts, allocations, cheques (spec §5.1). */
@Controller('payments')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post()
  @RequirePermissions('payments:manage')
  record(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(recordPaymentSchema)) body: RecordPaymentInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<PaymentView> {
    return this.payments.record(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPaymentsSchema)) query: ListPaymentsQuery,
  ): Promise<PaymentPage> {
    return this.payments.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
  ): Promise<PaymentView> {
    return this.payments.get(auth, paymentId);
  }

  @Get(':id/receipt')
  @RequirePermissions('sales:read')
  receipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
  ): Promise<ReceiptView> {
    return this.payments.receipt(auth, paymentId);
  }

  @Post(':id/allocate')
  @HttpCode(200)
  @RequirePermissions('payments:manage')
  allocate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
    @Body(new ZodValidationPipe(allocatePaymentSchema)) body: AllocatePaymentInput,
  ): Promise<PaymentView> {
    return this.payments.allocate(auth, paymentId, body);
  }

  @Post(':id/allocations/:allocationId/reverse')
  @HttpCode(200)
  @RequirePermissions('payments:manage')
  reverse(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
    @Param('allocationId', id()) allocationId: string,
  ): Promise<PaymentView> {
    return this.payments.reverseAllocation(auth, paymentId, allocationId);
  }

  @Post(':id/clear')
  @HttpCode(200)
  @RequirePermissions('payments:manage')
  clear(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
    @Body(new ZodValidationPipe(clearChequeSchema)) body: ClearChequeInput,
  ): Promise<PaymentView> {
    return this.payments.clear(auth, paymentId, body);
  }

  @Post(':id/bounce')
  @HttpCode(200)
  @RequirePermissions('payments:manage')
  bounce(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
    @Body(new ZodValidationPipe(bounceChequeSchema)) body: BounceChequeInput,
  ): Promise<PaymentView> {
    return this.payments.bounce(auth, paymentId, body);
  }

  @Post(':id/refund')
  @RequirePermissions('payments:manage')
  refund(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) paymentId: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<PaymentView> {
    return this.payments.refund(auth, paymentId, body, idempotencyKey);
  }
}

/** The ways a business takes money (spec §3.3). */
@Controller('payment-modes')
export class PaymentModesController {
  constructor(@Inject(PaymentModesService) private readonly modes: PaymentModesService) {}

  @Get()
  @RequirePermissions('sales:read')
  list(@CurrentAuth() auth: AuthContext): Promise<PaymentModeView[]> {
    return this.modes.list(auth);
  }

  @Post()
  @RequirePermissions('organization:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPaymentModeSchema)) body: CreatePaymentModeInput,
  ): Promise<PaymentModeView> {
    return this.modes.create(auth, body);
  }

  @Patch(':id')
  @RequirePermissions('organization:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) modeId: string,
    @Body(new ZodValidationPipe(updatePaymentModeSchema)) body: UpdatePaymentModeInput,
  ): Promise<PaymentModeView> {
    return this.modes.update(auth, modeId, body);
  }
}

/** A party's account: entries, balance and open bills (spec §5.1). */
@Controller('parties')
export class PartyLedgerController {
  constructor(@Inject(PartyLedgerService) private readonly ledger: PartyLedgerService) {}

  @Get(':id/ledger')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(partyLedgerQuerySchema)) query: PartyLedgerQuery,
  ): Promise<PartyLedgerView> {
    return this.ledger.ledger(auth, partyId, query);
  }
}

/** Opening a register (spec §5.5). */
@Controller('registers')
export class RegistersController {
  constructor(@Inject(RegistersService) private readonly registers: RegistersService) {}

  @Post(':code/open')
  @RequirePermissions('register:manage')
  open(
    @CurrentAuth() auth: AuthContext,
    @Param('code', new ZodValidationPipe(registerCodeSchema)) code: string,
    @Body(new ZodValidationPipe(openRegisterSchema)) body: OpenRegisterInput,
  ): Promise<RegisterSessionView> {
    return this.registers.open(auth, code, body);
  }
}

/** A register session: cash movements, close, Z-report figures (spec §5.5). */
@Controller('register-sessions')
export class RegisterSessionsController {
  constructor(@Inject(RegistersService) private readonly registers: RegistersService) {}

  @Get()
  @RequirePermissions('register:manage')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listRegisterSessionsSchema)) query: ListRegisterSessionsQuery,
  ): Promise<{ items: RegisterSessionSummary[]; total: number }> {
    return this.registers.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('register:manage')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) sessionId: string,
  ): Promise<RegisterSessionView> {
    return this.registers.get(auth, sessionId);
  }

  @Post(':id/movements')
  @RequirePermissions('register:manage')
  movement(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) sessionId: string,
    @Body(new ZodValidationPipe(cashMovementSchema)) body: CashMovementInput,
  ): Promise<RegisterSessionView> {
    return this.registers.movement(auth, sessionId, body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('register:manage')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) sessionId: string,
    @Body(new ZodValidationPipe(closeRegisterSchema)) body: CloseRegisterInput,
  ): Promise<RegisterSessionView> {
    return this.registers.close(auth, sessionId, body);
  }
}
