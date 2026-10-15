import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  COLLECTIONS_MANAGE_PERMISSION,
  RECEIVABLES_PERMISSION,
  REMINDER_SETTINGS_PERMISSION,
  type EscalationView,
  type PromiseView,
  type ReminderScheduleView,
  type WorklistPage,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  acknowledgeSchema,
  cancelPromiseSchema,
  createPromiseSchema,
  escalationsQuerySchema,
  reminderSchedulesSchema,
  worklistQuerySchema,
  type AcknowledgeInput,
  type CancelPromiseInput,
  type CreatePromiseInput,
  type EscalationsQueryInput,
  type ReminderSchedulesInput,
  type WorklistQueryInput,
} from './collections.schemas.js';
import { CollectionsService } from './collections.service.js';

const id = () => new ParseUUIDPipe();

/** Collections (roadmap P2-M11): promises to pay, the worklist, escalations, reminders. */
@Controller()
export class CollectionsController {
  constructor(@Inject(CollectionsService) private readonly collections: CollectionsService) {}

  @Get('parties/:id/promises')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  promises(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
  ): Promise<PromiseView[]> {
    return this.collections.partyPromises(auth, partyId);
  }

  @Post('parties/:id/promises')
  @RequirePermissions(COLLECTIONS_MANAGE_PERMISSION)
  createPromise(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(createPromiseSchema)) body: CreatePromiseInput,
  ): Promise<PromiseView> {
    return this.collections.createPromise(auth, partyId, body);
  }

  @Post('promises/:id/cancel')
  @HttpCode(200)
  @RequirePermissions(COLLECTIONS_MANAGE_PERMISSION)
  cancelPromise(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) promiseId: string,
    @Body(new ZodValidationPipe(cancelPromiseSchema)) body: CancelPromiseInput,
  ): Promise<PromiseView> {
    return this.collections.cancelPromise(auth, promiseId, body);
  }

  @Get('collections/worklist')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  worklist(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(worklistQuerySchema)) query: WorklistQueryInput,
  ): Promise<WorklistPage> {
    return this.collections.worklist(auth, query);
  }

  @Get('collections/escalations')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  escalations(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(escalationsQuerySchema)) query: EscalationsQueryInput,
  ): Promise<EscalationView[]> {
    return this.collections.escalations(auth, query);
  }

  @Post('collections/escalations/:id/acknowledge')
  @HttpCode(204)
  @RequirePermissions(COLLECTIONS_MANAGE_PERMISSION)
  acknowledge(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) escalationId: string,
    @Body(new ZodValidationPipe(acknowledgeSchema)) body: AcknowledgeInput,
  ): Promise<void> {
    return this.collections.acknowledge(auth, escalationId, body);
  }

  @Get('collections/reminder-schedules')
  @RequirePermissions(RECEIVABLES_PERMISSION)
  reminderSchedules(@CurrentAuth() auth: AuthContext): Promise<ReminderScheduleView[]> {
    return this.collections.reminderSchedules(auth);
  }

  @Put('collections/reminder-schedules')
  @RequirePermissions(REMINDER_SETTINGS_PERMISSION)
  saveReminderSchedules(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(reminderSchedulesSchema)) body: ReminderSchedulesInput,
  ): Promise<ReminderScheduleView[]> {
    return this.collections.saveReminderSchedules(auth, body);
  }
}
