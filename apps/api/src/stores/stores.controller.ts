import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { StoreDirectoryEntry } from '@paint/shared';
import { createStoreSchema, type CreateStoreInput } from './stores.schemas.js';
import { StoresService, type Store } from './stores.service.js';

@Controller('stores')
export class StoresController {
  constructor(@Inject(StoresService) private readonly stores: StoresService) {}

  @Get()
  @RequirePermissions('stores:read')
  list(@CurrentAuth() auth: AuthContext): Promise<Store[]> {
    return this.stores.list(auth);
  }

  /** Every open store of the business (id, code, name), for pickers. */
  @Get('directory')
  @RequirePermissions('stores:read')
  directory(@CurrentAuth() auth: AuthContext): Promise<StoreDirectoryEntry[]> {
    return this.stores.directory(auth);
  }

  @Get(':id')
  @RequirePermissions('stores:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<Store> {
    return this.stores.get(auth, id);
  }

  @Post()
  @RequirePermissions('stores:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createStoreSchema)) body: CreateStoreInput,
  ): Promise<Store> {
    return this.stores.create(auth, body);
  }
}
