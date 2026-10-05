import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { RoleView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createRoleSchema,
  updateRoleSchema,
  type CreateRoleInput,
  type UpdateRoleInput,
} from './roles.schemas.js';
import { RolesService } from './roles.service.js';

@Controller('roles')
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  /** Roles with their permissions, for choosing when adding people. */
  @Get()
  @RequirePermissions('members:read')
  list(@CurrentAuth() auth: AuthContext): Promise<RoleView[]> {
    return this.roles.list(auth);
  }

  @Post()
  @RequirePermissions('roles:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createRoleSchema)) body: CreateRoleInput,
  ): Promise<RoleView> {
    return this.roles.create(auth, body);
  }

  @Patch(':id')
  @RequirePermissions('roles:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) body: UpdateRoleInput,
  ): Promise<RoleView> {
    return this.roles.update(auth, id, body);
  }
}
