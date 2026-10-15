import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  CONSENT_MANAGE_PERMISSION,
  MESSAGING_READ_PERMISSION,
  TEMPLATES_MANAGE_PERMISSION,
  type MessageView,
  type MessagingStatus,
  type PartyConsentsView,
  type TemplateView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  messagesQuerySchema,
  recordConsentSchema,
  saveTemplateSchema,
  templateKeySchema,
  type MessagesQueryInput,
  type RecordConsentInput,
  type SaveTemplateInput,
  type TemplateKeyInput,
} from './messaging.schemas.js';
import { MessagingService } from './messaging.service.js';

const id = () => new ParseUUIDPipe();

/** Messages to parties (P2-M32): what can be sent, consent, the message log, templates. */
@Controller()
export class MessagingController {
  constructor(@Inject(MessagingService) private readonly messaging: MessagingService) {}

  /** Which channels this server sends on; any member (screens offer only those). */
  @Get('messaging/status')
  status(): MessagingStatus {
    return this.messaging.status();
  }

  @Get('parties/:id/consents')
  @RequirePermissions(MESSAGING_READ_PERMISSION)
  consents(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
  ): Promise<PartyConsentsView> {
    return this.messaging.consents(auth, partyId);
  }

  @Post('parties/:id/consents')
  @RequirePermissions(CONSENT_MANAGE_PERMISSION)
  recordConsent(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Body(new ZodValidationPipe(recordConsentSchema)) body: RecordConsentInput,
  ): Promise<PartyConsentsView> {
    return this.messaging.recordConsent(auth, partyId, body);
  }

  @Get('parties/:id/messages')
  @RequirePermissions(MESSAGING_READ_PERMISSION)
  messages(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) partyId: string,
    @Query(new ZodValidationPipe(messagesQuerySchema)) query: MessagesQueryInput,
  ): Promise<MessageView[]> {
    return this.messaging.messages(auth, partyId, query);
  }

  @Get('message-templates')
  @RequirePermissions(TEMPLATES_MANAGE_PERMISSION)
  templates(@CurrentAuth() auth: AuthContext): Promise<TemplateView[]> {
    return this.messaging.templates(auth);
  }

  @Put('message-templates')
  @RequirePermissions(TEMPLATES_MANAGE_PERMISSION)
  saveTemplate(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(saveTemplateSchema)) body: SaveTemplateInput,
  ): Promise<TemplateView[]> {
    return this.messaging.saveTemplate(auth, body);
  }

  @Delete('message-templates/:key/:channel/:language')
  @RequirePermissions(TEMPLATES_MANAGE_PERMISSION)
  resetTemplate(
    @CurrentAuth() auth: AuthContext,
    @Param(new ZodValidationPipe(templateKeySchema)) key: TemplateKeyInput,
  ): Promise<TemplateView[]> {
    return this.messaging.resetTemplate(auth, key);
  }
}
