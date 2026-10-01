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
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createPartySchema,
  listPartiesSchema,
  updatePartySchema,
  type CreatePartyInput,
  type ListPartiesQuery,
  type UpdatePartyInput,
} from './parties.schemas.js';
import { PartiesService, type PartyPage, type PartyView } from './parties.service.js';
import { PartyOverviewService, type PartyOverview } from './party-overview.service.js';

@Controller('parties')
export class PartiesController {
  constructor(
    @Inject(PartiesService) private readonly parties: PartiesService,
    @Inject(PartyOverviewService) private readonly overviews: PartyOverviewService,
  ) {}

  @Get()
  @RequirePermissions('parties:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPartiesSchema)) query: ListPartiesQuery,
  ): Promise<PartyPage> {
    return this.parties.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('parties:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PartyView> {
    return this.parties.get(auth, id);
  }

  /** The customer 360: the party with its leads, opportunities, projects, activities and documents. */
  @Get(':id/overview')
  @RequirePermissions('parties:read')
  overview(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PartyOverview> {
    return this.overviews.overview(auth, id);
  }

  @Post()
  @RequirePermissions('parties:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPartySchema)) body: CreatePartyInput,
  ): Promise<PartyView> {
    return this.parties.create(auth, body);
  }

  @Patch(':id')
  @RequirePermissions('parties:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePartySchema)) body: UpdatePartyInput,
  ): Promise<PartyView> {
    return this.parties.update(auth, id, body);
  }
}
