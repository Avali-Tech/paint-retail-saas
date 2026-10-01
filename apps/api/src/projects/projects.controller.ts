import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { assignSchema, reasonSchema } from '../leads/leads.schemas.js';
import {
  createProjectSchema,
  fromOpportunitySchema,
  listProjectsSchema,
  partiesSchema,
  projectPipelineSchema,
  projectStageSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type FromOpportunityInput,
  type ListProjectsQuery,
  type ProjectPartyLink,
  type ProjectPipelineQuery,
  type UpdateProjectInput,
  type WORK_STAGES,
} from './projects.schemas.js';
import { ProjectsService, type ProjectPage, type ProjectView } from './projects.service.js';

const id = () => new ParseUUIDPipe();

@Controller()
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Post('projects')
  @RequirePermissions('projects:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
  ): Promise<ProjectView> {
    return this.projects.create(auth, body);
  }

  /** Starts the project for a won or open opportunity. */
  @Post('opportunities/:id/project')
  @RequirePermissions('projects:manage')
  fromOpportunity(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) opportunityId: string,
    @Body(new ZodValidationPipe(fromOpportunitySchema)) body: FromOpportunityInput,
  ): Promise<ProjectView> {
    return this.projects.fromOpportunity(auth, opportunityId, body);
  }

  @Get('projects')
  @RequirePermissions('projects:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listProjectsSchema)) query: ListProjectsQuery,
  ): Promise<ProjectPage> {
    return this.projects.list(auth, query);
  }

  @Get('projects/pipeline')
  @RequirePermissions('projects:read')
  pipeline(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(projectPipelineSchema)) query: ProjectPipelineQuery,
  ): ReturnType<ProjectsService['pipeline']> {
    return this.projects.pipeline(auth, query);
  }

  @Get('projects/:id')
  @RequirePermissions('projects:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
  ): Promise<ProjectView> {
    return this.projects.get(auth, projectId);
  }

  @Patch('projects/:id')
  @RequirePermissions('projects:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
  ): Promise<ProjectView> {
    return this.projects.update(auth, projectId, body);
  }

  @Put('projects/:id/parties')
  @RequirePermissions('projects:manage')
  setParties(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
    @Body(new ZodValidationPipe(partiesSchema)) body: { parties: ProjectPartyLink[] },
  ): Promise<ProjectView> {
    return this.projects.setParties(auth, projectId, body.parties);
  }

  @Post('projects/:id/assign')
  @HttpCode(200)
  @RequirePermissions('projects:manage')
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
    @Body(new ZodValidationPipe(assignSchema)) body: { memberId: string },
  ): Promise<ProjectView> {
    return this.projects.assign(auth, projectId, body.memberId);
  }

  @Post('projects/:id/stage')
  @HttpCode(200)
  @RequirePermissions('projects:manage')
  moveTo(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
    @Body(new ZodValidationPipe(projectStageSchema)) body: { stage: (typeof WORK_STAGES)[number] },
  ): Promise<ProjectView> {
    return this.projects.moveTo(auth, projectId, body.stage);
  }

  @Post('projects/:id/cancel')
  @HttpCode(200)
  @RequirePermissions('projects:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) projectId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<ProjectView> {
    return this.projects.cancel(auth, projectId, body.reason);
  }
}
