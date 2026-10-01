import 'reflect-metadata';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { quickActions, type QuickAction } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { actionsSchema, searchSchema, type SearchQuery } from './search.schemas.js';
import { SearchService, type SearchResults } from './search.service.js';

// Open to every member: each group of results checks its own permission.
@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly searches: SearchService) {}

  @Get()
  search(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(searchSchema)) query: SearchQuery,
  ): Promise<SearchResults> {
    return this.searches.search(auth, query);
  }

  /** The quick actions the member may use, for the command palette. */
  @Get('actions')
  actions(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(actionsSchema)) query: { q: string },
  ): QuickAction[] {
    return quickActions(auth, query.q);
  }
}
