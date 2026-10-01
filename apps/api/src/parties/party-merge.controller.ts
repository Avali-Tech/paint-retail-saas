import 'reflect-metadata';
import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { mergeSchema } from './parties.schemas.js';
import { PartyMergeService, type MergeResult } from './party-merge.service.js';

@Controller('parties')
export class PartyMergeController {
  constructor(@Inject(PartyMergeService) private readonly merges: PartyMergeService) {}

  /** Merges this duplicate into another party; answers the surviving party and what moved. */
  @Post(':id/merge')
  @HttpCode(200)
  @RequirePermissions('parties:manage')
  merge(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) duplicateId: string,
    @Body(new ZodValidationPipe(mergeSchema)) body: { intoPartyId: string },
  ): Promise<MergeResult> {
    return this.merges.merge(auth, duplicateId, body.intoPartyId);
  }
}
