import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { LoyaltySettings } from './loyalty-lookups.js';
import {
  adjustSchema,
  awardSchema,
  enrolSchema,
  ledgerPageSchema,
  listAccountsSchema,
  loyaltySettingsSchema,
  purchaseSchema,
  redeemSchema,
  updateAccountSchema,
  type AdjustInput,
  type AwardInput,
  type ListAccountsQuery,
  type PurchaseInput,
  type RedeemInput,
  type UpdateAccountInput,
} from './loyalty.schemas.js';
import { LoyaltyService, type LoyaltyView } from './loyalty.service.js';

const id = () => new ParseUUIDPipe();

@Controller()
export class LoyaltyController {
  constructor(@Inject(LoyaltyService) private readonly loyalty: LoyaltyService) {}

  @Get('parties/:id/loyalty')
  @RequirePermissions('loyalty:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(ledgerPageSchema)) page: { limit: number; offset: number },
  ): Promise<LoyaltyView> {
    return this.loyalty.get(auth, partyId, page);
  }

  @Post('parties/:id/loyalty')
  @RequirePermissions('loyalty:manage')
  enrol(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(enrolSchema)) body: { assignedMemberId?: string },
  ): Promise<LoyaltyView> {
    return this.loyalty.enrol(auth, partyId, body.assignedMemberId);
  }

  @Patch('parties/:id/loyalty')
  @RequirePermissions('loyalty:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) body: UpdateAccountInput,
  ): Promise<LoyaltyView> {
    return this.loyalty.update(auth, partyId, body);
  }

  /** Points for a purchase entered by hand, until billing exists. */
  @Post('parties/:id/loyalty/purchases')
  @RequirePermissions('loyalty:manage')
  recordPurchase(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(purchaseSchema)) body: PurchaseInput,
  ): Promise<LoyaltyView> {
    return this.loyalty.recordPurchase(auth, partyId, body);
  }

  @Post('parties/:id/loyalty/awards')
  @RequirePermissions('loyalty:manage')
  award(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(awardSchema)) body: AwardInput,
  ): Promise<LoyaltyView> {
    return this.loyalty.award(auth, partyId, body);
  }

  @Post('parties/:id/loyalty/redemptions')
  @RequirePermissions('loyalty:manage')
  redeem(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(redeemSchema)) body: RedeemInput,
  ): Promise<LoyaltyView> {
    return this.loyalty.redeem(auth, partyId, body);
  }

  @Post('parties/:id/loyalty/adjustments')
  @RequirePermissions('loyalty:manage')
  adjust(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(adjustSchema)) body: AdjustInput,
  ): Promise<LoyaltyView> {
    return this.loyalty.adjust(auth, partyId, body);
  }

  @Get('loyalty-accounts')
  @RequirePermissions('loyalty:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listAccountsSchema)) query: ListAccountsQuery,
  ): ReturnType<LoyaltyService['list']> {
    return this.loyalty.list(auth, query);
  }

  @Get('loyalty-settings')
  @RequirePermissions('loyalty:read')
  settings(@CurrentAuth() auth: AuthContext): Promise<LoyaltySettings> {
    return this.loyalty.settings(auth);
  }

  @Put('loyalty-settings')
  @RequirePermissions('loyalty:manage')
  setSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(loyaltySettingsSchema)) body: LoyaltySettings,
  ): Promise<LoyaltySettings> {
    return this.loyalty.setSettings(auth, body);
  }
}
