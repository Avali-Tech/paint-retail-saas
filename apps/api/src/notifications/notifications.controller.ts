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
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  listNotificationsSchema,
  preferencesSchema,
  type ListNotificationsQuery,
  type PreferencesInput,
} from './notifications.schemas.js';
import {
  NotificationsService,
  type NotificationPage,
  type PreferenceView,
} from './notifications.service.js';

// Every member manages only their own notifications, so no permission is needed.
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listNotificationsSchema)) query: ListNotificationsQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(auth, query);
  }

  @Get('preferences')
  preferences(@CurrentAuth() auth: AuthContext): Promise<PreferenceView[]> {
    return this.notifications.preferences(auth);
  }

  @Put('preferences')
  savePreferences(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(preferencesSchema)) body: PreferencesInput,
  ): Promise<PreferenceView[]> {
    return this.notifications.savePreferences(auth, body);
  }

  @Post('read-all')
  @HttpCode(200)
  markAllRead(@CurrentAuth() auth: AuthContext): Promise<{ marked: number }> {
    return this.notifications.markAllRead(auth);
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) notificationId: string,
  ): Promise<void> {
    return this.notifications.markRead(auth, notificationId);
  }
}
