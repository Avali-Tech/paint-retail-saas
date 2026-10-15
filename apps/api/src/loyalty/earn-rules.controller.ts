import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import type { EarnRuleView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { earnRuleSchema, type EarnRuleBody } from './earn-rules.schemas.js';
import { EarnRulesService } from './earn-rules.service.js';

/** Painter points earn rules (P2-M36). */
@Controller('loyalty-earn-rules')
export class EarnRulesController {
  constructor(@Inject(EarnRulesService) private readonly rules: EarnRulesService) {}

  @Get()
  @RequirePermissions('loyalty:read')
  list(@CurrentAuth() auth: AuthContext): Promise<EarnRuleView[]> {
    return this.rules.list(auth);
  }

  @Post()
  @RequirePermissions('loyalty:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(earnRuleSchema)) body: EarnRuleBody,
  ): Promise<EarnRuleView> {
    return this.rules.create(auth, body);
  }

  @Put(':id')
  @RequirePermissions('loyalty:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(earnRuleSchema)) body: EarnRuleBody,
  ): Promise<EarnRuleView> {
    return this.rules.update(auth, id, body);
  }
}
