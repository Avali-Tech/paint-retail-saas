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
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  assignSchema,
  createOpportunitySchema,
  listOpportunitiesSchema,
  opportunityStageSchema,
  pipelineSchema,
  reasonSchema,
  updateOpportunitySchema,
  type CreateOpportunityInput,
  type ListOpportunitiesQuery,
  type OpportunityStageInput,
  type PipelineQuery,
  type UpdateOpportunityInput,
} from './leads.schemas.js';
import {
  OpportunitiesService,
  type OpportunityPage,
  type OpportunityStageTotal,
  type OpportunityView,
} from './opportunities.service.js';

const id = () => new ParseUUIDPipe();

@Controller('opportunities')
export class OpportunitiesController {
  constructor(@Inject(OpportunitiesService) private readonly opportunities: OpportunitiesService) {}

  @Post()
  @RequirePermissions('leads:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createOpportunitySchema)) body: CreateOpportunityInput,
  ): Promise<OpportunityView> {
    return this.opportunities.create(auth, body);
  }

  @Get()
  @RequirePermissions('leads:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listOpportunitiesSchema)) query: ListOpportunitiesQuery,
  ): Promise<OpportunityPage> {
    return this.opportunities.list(auth, query);
  }

  @Get('pipeline')
  @RequirePermissions('leads:read')
  pipeline(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pipelineSchema)) query: PipelineQuery,
  ): Promise<OpportunityStageTotal[]> {
    return this.opportunities.pipeline(auth, query);
  }

  @Get(':id')
  @RequirePermissions('leads:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
  ): Promise<OpportunityView> {
    return this.opportunities.get(auth, opportunityId);
  }

  @Patch(':id')
  @RequirePermissions('leads:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
    @Body(new ZodValidationPipe(updateOpportunitySchema)) body: UpdateOpportunityInput,
  ): Promise<OpportunityView> {
    return this.opportunities.update(auth, opportunityId, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: { memberId: string },
  ): Promise<OpportunityView> {
    return this.opportunities.assign(auth, opportunityId, body.memberId);
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  moveTo(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
    @Body(new ZodValidationPipe(opportunityStageSchema)) body: OpportunityStageInput,
  ): Promise<OpportunityView> {
    return this.opportunities.moveTo(auth, opportunityId, body);
  }

  @Post(':id/win')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  win(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
  ): Promise<OpportunityView> {
    return this.opportunities.win(auth, opportunityId);
  }

  @Post(':id/lose')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  lose(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<OpportunityView> {
    return this.opportunities.lose(auth, opportunityId, body.reason);
  }
}
