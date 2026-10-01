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
  convertLeadSchema,
  createLeadSchema,
  leadStageSchema,
  listLeadsSchema,
  pipelineSchema,
  reasonSchema,
  updateLeadSchema,
  type ConvertLeadInput,
  type CreateLeadInput,
  type ListLeadsQuery,
  type OPEN_LEAD_STAGES,
  type PipelineQuery,
  type UpdateLeadInput,
} from './leads.schemas.js';
import { LeadsService, type LeadPage, type LeadView, type StageTotal } from './leads.service.js';
import type { OpportunityView } from './opportunities.service.js';

const id = () => new ParseUUIDPipe();

@Controller('leads')
export class LeadsController {
  constructor(@Inject(LeadsService) private readonly leads: LeadsService) {}

  @Post()
  @RequirePermissions('leads:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createLeadSchema)) body: CreateLeadInput,
  ): Promise<LeadView> {
    return this.leads.create(auth, body);
  }

  @Get()
  @RequirePermissions('leads:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listLeadsSchema)) query: ListLeadsQuery,
  ): Promise<LeadPage> {
    return this.leads.list(auth, query);
  }

  @Get('pipeline')
  @RequirePermissions('leads:read')
  pipeline(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(pipelineSchema)) query: PipelineQuery,
  ): Promise<StageTotal[]> {
    return this.leads.pipeline(auth, query);
  }

  @Get(':id')
  @RequirePermissions('leads:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', id()) leadId: string): Promise<LeadView> {
    return this.leads.get(auth, leadId);
  }

  @Patch(':id')
  @RequirePermissions('leads:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) leadId: string,
    @Body(new ZodValidationPipe(updateLeadSchema)) body: UpdateLeadInput,
  ): Promise<LeadView> {
    return this.leads.update(auth, leadId, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) leadId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: { memberId: string },
  ): Promise<LeadView> {
    return this.leads.assign(auth, leadId, body.memberId);
  }

  @Post(':id/stage')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  moveTo(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) leadId: string,
    @Body(new ZodValidationPipe(leadStageSchema))
    body: { stage: (typeof OPEN_LEAD_STAGES)[number] },
  ): Promise<LeadView> {
    return this.leads.moveTo(auth, leadId, body.stage);
  }

  @Post(':id/lose')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  lose(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) leadId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<LeadView> {
    return this.leads.lose(auth, leadId, body.reason);
  }

  @Post(':id/win')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  win(@CurrentAuth() auth: AuthContext, @Param('id', id()) leadId: string): Promise<LeadView> {
    return this.leads.win(auth, leadId);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('leads:manage')
  reopen(@CurrentAuth() auth: AuthContext, @Param('id', id()) leadId: string): Promise<LeadView> {
    return this.leads.reopen(auth, leadId);
  }

  @Post(':id/convert')
  @RequirePermissions('leads:manage')
  convert(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) leadId: string,
    @Body(new ZodValidationPipe(convertLeadSchema)) body: ConvertLeadInput,
  ): Promise<OpportunityView> {
    return this.leads.convert(auth, leadId, body);
  }
}
