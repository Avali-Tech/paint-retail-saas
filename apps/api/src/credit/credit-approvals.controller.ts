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
  CreditApprovalDetail,
  CreditApprovalPage,
  CreditApprovalView,
  SiteAccountDetail,
  SiteAccountView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  approveSchema,
  createApprovalSchema,
  listApprovalsSchema,
  rejectSchema,
  type ApproveInput,
  type CreateApprovalInput,
  type ListApprovalsQuery,
} from './credit-approvals.schemas.js';
import { CreditApprovalsService } from './credit-approvals.service.js';
import {
  createSiteSchema,
  siteHoldSchema,
  updateSiteSchema,
  type CreateSiteInput,
  type UpdateSiteInput,
} from './site-accounts.schemas.js';
import { SiteAccountsService } from './site-accounts.service.js';

const id = () => new ParseUUIDPipe();

/**
 * Credit approvals (MVP 3 spec §4.3, §5.1). Asking checks the permission of
 * the sale (sales:manage for an order, billing:issue for an invoice,
 * credit:manage for a release); deciding checks the level's approver
 * (credit:approve_sale at the store, the Owner role, credit:approve for a
 * release) in the service.
 */
@Controller('credit-approvals')
export class CreditApprovalsController {
  constructor(@Inject(CreditApprovalsService) private readonly approvals: CreditApprovalsService) {}

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createApprovalSchema)) body: CreateApprovalInput,
  ): Promise<CreditApprovalView> {
    return this.approvals.create(auth, body);
  }

  @Get()
  @RequirePermissions('credit:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listApprovalsSchema)) query: ListApprovalsQuery,
  ): Promise<CreditApprovalPage> {
    return this.approvals.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('credit:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) approvalId: string,
  ): Promise<CreditApprovalDetail> {
    return this.approvals.get(auth, approvalId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) approvalId: string,
    @Body(new ZodValidationPipe(approveSchema)) body: ApproveInput,
  ): Promise<CreditApprovalView> {
    return this.approvals.approve(auth, approvalId, body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) approvalId: string,
    @Body(new ZodValidationPipe(rejectSchema)) body: { reason: string },
  ): Promise<CreditApprovalView> {
    return this.approvals.reject(auth, approvalId, body.reason);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) approvalId: string,
  ): Promise<CreditApprovalView> {
    return this.approvals.cancel(auth, approvalId);
  }
}

/** Site (job) accounts under a contractor (MVP 3 spec §3.3). */
@Controller()
export class SiteAccountsController {
  constructor(@Inject(SiteAccountsService) private readonly sites: SiteAccountsService) {}

  @Get('parties/:id/sites')
  @RequirePermissions('credit:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
  ): Promise<SiteAccountView[]> {
    return this.sites.list(auth, partyId);
  }

  @Post('parties/:id/sites')
  @RequirePermissions('credit:approve')
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(createSiteSchema)) body: CreateSiteInput,
  ): Promise<SiteAccountView> {
    return this.sites.create(auth, partyId, body);
  }

  @Get('site-accounts/:id')
  @RequirePermissions('credit:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) siteId: string,
  ): Promise<SiteAccountDetail> {
    return this.sites.get(auth, siteId);
  }

  @Patch('site-accounts/:id')
  @RequirePermissions('credit:approve')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) siteId: string,
    @Body(new ZodValidationPipe(updateSiteSchema)) body: UpdateSiteInput,
  ): Promise<SiteAccountView> {
    return this.sites.update(auth, siteId, body);
  }

  @Post('site-accounts/:id/hold')
  @HttpCode(200)
  @RequirePermissions('credit:manage')
  hold(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) siteId: string,
    @Body(new ZodValidationPipe(siteHoldSchema)) body: { reason: string },
  ): Promise<SiteAccountView> {
    return this.sites.hold(auth, siteId, body.reason);
  }

  @Post('site-accounts/:id/release')
  @HttpCode(200)
  @RequirePermissions('credit:approve')
  release(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) siteId: string,
  ): Promise<SiteAccountView> {
    return this.sites.release(auth, siteId);
  }

  @Post('site-accounts/:id/close')
  @HttpCode(200)
  @RequirePermissions('credit:approve')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) siteId: string,
  ): Promise<SiteAccountView> {
    return this.sites.close(auth, siteId);
  }
}
