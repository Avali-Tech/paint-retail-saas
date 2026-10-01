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
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  completeActivitySchema,
  createActivitySchema,
  followUpsSchema,
  timelineSchema,
  updateActivitySchema,
  type CompleteActivityInput,
  type CreateActivityInput,
  type FollowUpsQuery,
  type TimelineQuery,
  type UpdateActivityInput,
} from './activities.schemas.js';
import {
  ActivitiesService,
  type ActivityPage,
  type ActivityView,
  type FollowUpPage,
} from './activities.service.js';

const id = () => new ParseUUIDPipe();

// Access follows the record an activity is about (a party, lead, opportunity or
// project); the service checks it.
@Controller('activities')
export class ActivitiesController {
  constructor(@Inject(ActivitiesService) private readonly activities: ActivitiesService) {}

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createActivitySchema)) body: CreateActivityInput,
  ): Promise<ActivityView> {
    return this.activities.create(auth, body);
  }

  /** A record's timeline. */
  @Get()
  timeline(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(timelineSchema)) query: TimelineQuery,
  ): Promise<ActivityPage> {
    return this.activities.timeline(auth, query);
  }

  /** "My follow-ups today", overdue and upcoming. */
  @Get('follow-ups')
  followUps(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(followUpsSchema)) query: FollowUpsQuery,
  ): Promise<FollowUpPage> {
    return this.activities.followUps(auth, query);
  }

  @Get(':id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) activityId: string,
  ): Promise<ActivityView> {
    return this.activities.get(auth, activityId);
  }

  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) activityId: string,
    @Body(new ZodValidationPipe(updateActivitySchema)) body: UpdateActivityInput,
  ): Promise<ActivityView> {
    return this.activities.update(auth, activityId, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) activityId: string,
    @Body(new ZodValidationPipe(completeActivitySchema)) body: CompleteActivityInput,
  ): Promise<{ completed: ActivityView; next: ActivityView | null }> {
    return this.activities.complete(auth, activityId, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) activityId: string,
  ): Promise<ActivityView> {
    return this.activities.cancel(auth, activityId);
  }
}
