import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  listSuppliersSchema,
  supplierProductsSchema,
  supplierProfileSchema,
  type ListSuppliersQuery,
  type SupplierProductsInput,
  type SupplierProfileInput,
} from './purchasing.schemas.js';
import { SuppliersService, type SupplierPage, type SupplierView } from './suppliers.service.js';

const id = () => new ParseUUIDPipe();

@Controller('suppliers')
export class SuppliersController {
  constructor(@Inject(SuppliersService) private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermissions('purchasing:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listSuppliersSchema)) query: ListSuppliersQuery,
  ): Promise<SupplierPage> {
    return this.suppliers.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('purchasing:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) supplierId: string,
  ): Promise<SupplierView> {
    return this.suppliers.get(auth, supplierId);
  }

  @Put(':id/profile')
  @RequirePermissions('purchasing:manage')
  saveProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) supplierId: string,
    @Body(new ZodValidationPipe(supplierProfileSchema)) body: SupplierProfileInput,
  ): Promise<SupplierView> {
    return this.suppliers.saveProfile(auth, supplierId, body);
  }

  @Put(':id/products')
  @RequirePermissions('purchasing:manage')
  saveProducts(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) supplierId: string,
    @Body(new ZodValidationPipe(supplierProductsSchema)) body: SupplierProductsInput,
  ): Promise<SupplierView> {
    return this.suppliers.saveProducts(auth, supplierId, body);
  }

  @Delete(':id/products/:variantId')
  @HttpCode(204)
  @RequirePermissions('purchasing:manage')
  removeProduct(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) supplierId: string,
    @Param('variantId', id()) variantId: string,
  ): Promise<void> {
    return this.suppliers.removeProduct(auth, supplierId, variantId);
  }
}
