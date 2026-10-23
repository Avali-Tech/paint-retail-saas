import 'reflect-metadata';
import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  availabilitySchema,
  createMovementSchema,
  ledgerSchema,
  listStockSchema,
  type CreateMovementInput,
  type LedgerQuery,
  type ListStockQuery,
} from './inventory.schemas.js';
import {
  InventoryService,
  type Availability,
  type FreeElsewhere,
  type LedgerPage,
  type StockPage,
} from './inventory.service.js';

@Controller('stock')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listStockSchema)) query: ListStockQuery,
  ): Promise<StockPage> {
    return this.inventory.listStock(auth, query);
  }

  @Get('availability')
  @RequirePermissions('inventory:read')
  availability(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(availabilitySchema)) query: { variantId: string },
  ): Promise<Availability[]> {
    return this.inventory.availability(auth, query.variantId);
  }

  @Get('free-elsewhere')
  @RequirePermissions('inventory:read')
  freeElsewhere(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(availabilitySchema)) query: { variantId: string },
  ): Promise<FreeElsewhere> {
    return this.inventory.freeElsewhere(auth, query.variantId);
  }

  @Get('ledger')
  @RequirePermissions('inventory:read')
  ledger(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(ledgerSchema)) query: LedgerQuery,
  ): Promise<LedgerPage> {
    return this.inventory.ledger(auth, query);
  }

  @Post('movements')
  @RequirePermissions('inventory:manage')
  record(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createMovementSchema)) body: CreateMovementInput,
  ): Promise<LedgerPage> {
    return this.inventory.recordMovements(auth, body);
  }
}
