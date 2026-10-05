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
  brandSchema,
  categorySchema,
  createProductSchema,
  listProductsSchema,
  lookupSchema,
  updateBrandSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
  variantSchema,
  type CreateProductInput,
  type ListProductsQuery,
  type UpdateProductInput,
  type UpdateVariantInput,
  type VariantInput,
} from './catalog.schemas.js';
import {
  CatalogService,
  type BrandView,
  type CategoryView,
  type LookupResult,
  type ProductPage,
  type ProductView,
} from './catalog.service.js';

const id = () => new ParseUUIDPipe();

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get('brands')
  @RequirePermissions('catalog:read')
  listBrands(@CurrentAuth() auth: AuthContext): Promise<BrandView[]> {
    return this.catalog.listBrands(auth);
  }

  @Post('brands')
  @RequirePermissions('catalog:manage')
  createBrand(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(brandSchema)) body: { name: string },
  ): Promise<BrandView> {
    return this.catalog.createBrand(auth, body);
  }

  @Patch('brands/:id')
  @RequirePermissions('catalog:manage')
  updateBrand(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) brandId: string,
    @Body(new ZodValidationPipe(updateBrandSchema)) body: { name?: string; isActive?: boolean },
  ): Promise<BrandView> {
    return this.catalog.updateBrand(auth, brandId, body);
  }

  @Get('categories')
  @RequirePermissions('catalog:read')
  listCategories(@CurrentAuth() auth: AuthContext): Promise<CategoryView[]> {
    return this.catalog.listCategories(auth);
  }

  @Post('categories')
  @RequirePermissions('catalog:manage')
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(categorySchema)) body: { name: string; parentId?: string },
  ): Promise<CategoryView> {
    return this.catalog.createCategory(auth, body);
  }

  @Patch('categories/:id')
  @RequirePermissions('catalog:manage')
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) categoryId: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: { name?: string; isActive?: boolean },
  ): Promise<CategoryView> {
    return this.catalog.updateCategory(auth, categoryId, body);
  }

  @Get('products')
  @RequirePermissions('catalog:read')
  listProducts(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listProductsSchema)) query: ListProductsQuery,
  ): Promise<ProductPage> {
    return this.catalog.listProducts(auth, query);
  }

  @Get('products/lookup')
  @RequirePermissions('catalog:read')
  lookup(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(lookupSchema)) query: { code: string; includeInactive: boolean },
  ): Promise<LookupResult> {
    return this.catalog.lookup(auth, query.code, query.includeInactive);
  }

  @Get('products/:id')
  @RequirePermissions('catalog:read')
  getProduct(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) productId: string,
  ): Promise<ProductView> {
    return this.catalog.getProduct(auth, productId);
  }

  @Post('products')
  @RequirePermissions('catalog:manage')
  createProduct(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductInput,
  ): Promise<ProductView> {
    return this.catalog.createProduct(auth, body);
  }

  @Patch('products/:id')
  @RequirePermissions('catalog:manage')
  updateProduct(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductInput,
  ): Promise<ProductView> {
    return this.catalog.updateProduct(auth, productId, body);
  }

  @Post('products/:id/variants')
  @RequirePermissions('catalog:manage')
  addVariant(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(variantSchema)) body: VariantInput,
  ): Promise<ProductView> {
    return this.catalog.addVariant(auth, productId, body);
  }

  @Patch('variants/:id')
  @RequirePermissions('catalog:manage')
  updateVariant(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) variantId: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantInput,
  ): Promise<ProductView> {
    return this.catalog.updateVariant(auth, variantId, body);
  }
}
