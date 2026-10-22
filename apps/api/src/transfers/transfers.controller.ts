import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createTransferSchema,
  listTransfersSchema,
  quantitiesSchema,
  reasonSchema,
  receiveSchema,
  type CreateTransferInput,
  type ListTransfersQuery,
  type QuantitiesInput,
  type ReceiveInput,
} from './transfers.schemas.js';
import {
  TransfersService,
  type Challan,
  type TransferPage,
  type TransferView,
} from './transfers.service.js';

const id = () => new ParseUUIDPipe();

@Controller('transfers')
export class TransfersController {
  constructor(@Inject(TransfersService) private readonly transfers: TransfersService) {}

  @Post()
  // Stock staff, or anyone who bills at the receiving store (checked in the service).
  @RequirePermissions('inventory:read')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createTransferSchema)) body: CreateTransferInput,
  ): Promise<TransferView> {
    return this.transfers.create(auth, body);
  }

  @Get()
  @RequirePermissions('inventory:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listTransfersSchema)) query: ListTransfersQuery,
  ): Promise<TransferPage> {
    return this.transfers.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('inventory:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
  ): Promise<TransferView> {
    return this.transfers.get(auth, transferId);
  }

  @Get(':id/challan')
  @RequirePermissions('inventory:read')
  challan(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
  ): Promise<Challan> {
    return this.transfers.challan(auth, transferId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(quantitiesSchema)) body: QuantitiesInput,
  ): Promise<TransferView> {
    return this.transfers.approve(auth, transferId, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<TransferView> {
    return this.transfers.reject(auth, transferId, body.reason);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<TransferView> {
    return this.transfers.cancel(auth, transferId, body.reason);
  }

  @Post(':id/dispatch')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  dispatch(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(quantitiesSchema)) body: QuantitiesInput,
  ): Promise<TransferView> {
    return this.transfers.dispatch(auth, transferId, body);
  }

  @Post(':id/receive')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  receive(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) transferId: string,
    @Body(new ZodValidationPipe(receiveSchema)) body: ReceiveInput,
  ): Promise<TransferView> {
    return this.transfers.receive(auth, transferId, body);
  }
}
