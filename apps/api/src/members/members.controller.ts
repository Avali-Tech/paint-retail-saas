import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createMemberSchema,
  updateMemberSchema,
  type CreateMemberInput,
  type UpdateMemberInput,
} from './members.schemas.js';
import type { MemberView } from '@paint/shared';
import { MembersService } from './members.service.js';

@Controller()
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get('members')
  @RequirePermissions('members:read')
  list(@CurrentAuth() auth: AuthContext): Promise<MemberView[]> {
    return this.members.list(auth);
  }

  @Get('members/:id')
  @RequirePermissions('members:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MemberView> {
    return this.members.get(auth, id);
  }

  @Post('members')
  @RequirePermissions('members:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createMemberSchema)) body: CreateMemberInput,
  ): Promise<MemberView> {
    return this.members.create(auth, body);
  }

  @Patch('members/:id')
  @RequirePermissions('members:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: UpdateMemberInput,
  ): Promise<MemberView> {
    return this.members.update(auth, id, body);
  }
}
