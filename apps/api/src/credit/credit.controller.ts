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
  Put,
  Query,
} from '@nestjs/common';
import type { CreditCheck, CreditRules } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  creditCheckSchema,
  creditRequestSchema,
  creditRulesSchema,
  decisionSchema,
  holdSchema,
  listCreditSchema,
  listRequestsSchema,
  rejectionSchema,
  updateCreditSchema,
  type CreditRequestInput,
  type ListCreditQuery,
  type ListRequestsQuery,
  type UpdateCreditInput,
} from './credit.schemas.js';
import { CreditService, type CreditRequestView, type CreditView } from './credit.service.js';
import { releaseSchema, type ReleaseInput } from './credit-approvals.schemas.js';

const id = () => new ParseUUIDPipe();

@Controller()
export class CreditController {
  constructor(@Inject(CreditService) private readonly credit: CreditService) {}

  @Get('parties/:id/credit')
  @RequirePermissions('credit:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', id()) partyId: string): Promise<CreditView> {
    return this.credit.get(auth, partyId);
  }

  @Get('parties/:id/credit/check')
  @RequirePermissions('credit:read')
  check(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(creditCheckSchema)) query: { amountPaise: number },
  ): Promise<CreditCheck> {
    return this.credit.check(auth, partyId, query.amountPaise);
  }

  @Patch('parties/:id/credit')
  @RequirePermissions('credit:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(updateCreditSchema)) body: UpdateCreditInput,
  ): Promise<CreditView> {
    return this.credit.update(auth, partyId, body);
  }

  @Post('parties/:id/credit/hold')
  @HttpCode(200)
  @RequirePermissions('credit:manage')
  hold(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(holdSchema)) body: { reason: string },
  ): Promise<CreditView> {
    return this.credit.hold(auth, partyId, body.reason);
  }

  @Post('parties/:id/credit/release')
  @HttpCode(200)
  @RequirePermissions('credit:approve')
  release(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(releaseSchema)) body: ReleaseInput,
  ): Promise<CreditView> {
    return this.credit.release(auth, partyId, body);
  }

  @Get('credit-profiles')
  @RequirePermissions('credit:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listCreditSchema)) query: ListCreditQuery,
  ): ReturnType<CreditService['list']> {
    return this.credit.list(auth, query);
  }

  @Post('credit-requests')
  @RequirePermissions('credit:manage')
  request(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(creditRequestSchema)) body: CreditRequestInput,
  ): Promise<CreditRequestView> {
    return this.credit.request(auth, body);
  }

  @Get('credit-requests')
  @RequirePermissions('credit:read')
  listRequests(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listRequestsSchema)) query: ListRequestsQuery,
  ): ReturnType<CreditService['listRequests']> {
    return this.credit.listRequests(auth, query);
  }

  @Get('credit-requests/:id')
  @RequirePermissions('credit:read')
  getRequest(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) requestId: string,
  ): Promise<CreditRequestView> {
    return this.credit.getRequest(auth, requestId);
  }

  @Post('credit-requests/:id/approve')
  @HttpCode(200)
  @RequirePermissions('credit:approve')
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) requestId: string,
    @Body(new ZodValidationPipe(decisionSchema)) body: { note?: string },
  ): Promise<CreditRequestView> {
    return this.credit.approve(auth, requestId, body.note);
  }

  @Post('credit-requests/:id/reject')
  @HttpCode(200)
  @RequirePermissions('credit:approve')
  reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) requestId: string,
    @Body(new ZodValidationPipe(rejectionSchema)) body: { reason: string },
  ): Promise<CreditRequestView> {
    return this.credit.reject(auth, requestId, body.reason);
  }

  @Get('credit-rules')
  @RequirePermissions('credit:read')
  rules(@CurrentAuth() auth: AuthContext): Promise<CreditRules> {
    return this.credit.rules(auth);
  }

  @Put('credit-rules')
  @RequirePermissions('credit:approve')
  setRules(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(creditRulesSchema)) body: CreditRules,
  ): Promise<CreditRules> {
    return this.credit.setRules(auth, body);
  }
}
