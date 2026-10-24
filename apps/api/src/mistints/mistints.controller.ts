import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { MistintPage, MistintView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  listMistintsSchema,
  recordMistintSchema,
  writeOffMistintSchema,
  type ListMistintsQuery,
  type RecordMistintInput,
  type WriteOffMistintInput,
} from './mistints.schemas.js';
import { MistintsService } from './mistints.service.js';

@Controller('mistinted-cans')
export class MistintsController {
  constructor(@Inject(MistintsService) private readonly mistints: MistintsService) {}

  /** Counter staff (billing:issue) or stock staff (inventory:manage), at their store; checked inside. */
  @Post()
  record(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(recordMistintSchema)) body: RecordMistintInput,
  ): Promise<MistintView> {
    return this.mistints.record(auth, body);
  }

  @Get()
  @RequirePermissions('inventory:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listMistintsSchema)) query: ListMistintsQuery,
  ): Promise<MistintPage> {
    return this.mistints.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('inventory:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MistintView> {
    return this.mistints.get(auth, id);
  }

  @Post(':id/write-off')
  @RequirePermissions('inventory:manage')
  writeOff(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(writeOffMistintSchema)) body: WriteOffMistintInput,
  ): Promise<MistintView> {
    return this.mistints.writeOff(auth, id, body);
  }
}
