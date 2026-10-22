import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  listRulesSchema,
  lowStockSchema,
  saveRulesSchema,
  slowMoversSchema,
  reorderSuggestionsSchema,
  type ReorderSuggestionsQuery,
  type ListRulesQuery,
  type LowStockQuery,
  type SaveRulesInput,
  type SlowMoversQuery,
} from './reorder.schemas.js';
import {
  ReorderService,
  type LowStockItem,
  type Page,
  type RuleView,
  type SlowMover,
  type ReorderSuggestion,
} from './reorder.service.js';

@Controller()
export class ReorderController {
  constructor(@Inject(ReorderService) private readonly reorder: ReorderService) {}

  @Put('reorder-rules')
  @RequirePermissions('inventory:manage')
  save(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(saveRulesSchema)) body: SaveRulesInput,
  ): Promise<{ saved: number }> {
    return this.reorder.saveRules(auth, body);
  }

  @Get('reorder-rules')
  @RequirePermissions('inventory:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listRulesSchema)) query: ListRulesQuery,
  ): Promise<Page<RuleView>> {
    return this.reorder.listRules(auth, query);
  }

  @Delete('reorder-rules/:storeId/:variantId')
  @HttpCode(204)
  @RequirePermissions('inventory:manage')
  remove(
    @CurrentAuth() auth: AuthContext,
    @Param('storeId', new ParseUUIDPipe()) storeId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
  ): Promise<void> {
    return this.reorder.removeRule(auth, storeId, variantId);
  }

  @Get('stock/low')
  @RequirePermissions('inventory:read')
  low(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(lowStockSchema)) query: LowStockQuery,
  ): Promise<Page<LowStockItem>> {
    return this.reorder.lowStock(auth, query);
  }

  @Get('stock/slow-movers')
  @RequirePermissions('inventory:read')
  slow(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(slowMoversSchema)) query: SlowMoversQuery,
  ): Promise<Page<SlowMover>> {
    return this.reorder.slowMovers(auth, query);
  }

  @Get('reorder-rules/suggestions')
  @RequirePermissions('inventory:read')
  suggestions(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(reorderSuggestionsSchema)) query: ReorderSuggestionsQuery,
  ): Promise<Page<ReorderSuggestion>> {
    return this.reorder.suggestions(auth, query);
  }
}
